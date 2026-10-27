/**
 * recap-rewind.ts - Recap span summarization + mindmap patch decision
 *
 * recap is a META-TOOL: its tool definition exists for LLM visibility, but the
 * real work happens in the state machine (hook.ts) because it needs triologue
 * access, which is not part of AgentContext.
 *
 * The rewind itself (truncate at the last brief + append the merge note) lives
 * in the triologue facade — see Triologue.getLastBrief() / rewindToLastBrief().
 * This module only produces the TEXT that goes into that note, plus the
 * concurrent mindmap patch decision.
 */

import type { Message, Tool } from '../types.js';
import type { Mindmap, MindmapPatchAction, Node } from '../mindmap/types.js';
import { get_node } from '../mindmap/get-node.js';
import { forkChat } from '../engine/chat-provider.js';
import { StreamAbortedError } from '../engine/chat-helpers.js';
import { agentIO } from './agent-io.js';
import { startSpinner, stopSpinner } from '../engine/chat-helpers.js';

/**
 * Validate that recap is called alone (no other tools in same turn)
 */
export { MIN_RECAP_SUMMARY_CHARS } from './states/hook.js';

export function validateRecapIsolation(toolCalls: Array<{ function: { name: string } }>): { valid: boolean; message?: string } {
  const hasRecap = toolCalls.some(c => c.function.name === 'recap');
  if (!hasRecap) {
    return { valid: true };
  }
  
  if (toolCalls.length > 1) {
    return {
      valid: false,
      message: 'Recap must be called alone. Other tools cannot be used in the same turn.',
    };
  }
  
  return { valid: true };
}

/**
 * Build the summarization prompt, merged into the last user message of the
 * full triologue.
 *
 * CACHE INVARIANT — do NOT "optimize" the recap fork call by:
 *   - minifying/truncating the messages, or
 *   - dropping the tools array.
 * The recap fork reuses the prompt-cache prefix the main agent loop already
 * paid for. That cached prefix is the EXACT token sequence of
 *   system + projectContext + conversation messages + full tools schema.
 * Minifying rewrites the message sequence → cache miss; omitting tools drops
 * cached tokens → cache miss. Either forces a full recompute of the entire
 * conversation, far costlier than any request-size savings.
 *
 * The ONE safe knob is `toolChoice: 'none'` — it is a sampling parameter
 * (governs whether the model may EMIT tool calls), NOT part of the cached
 * prefix token sequence, so the tools schema stays cached while output is
 * constrained to text-only at the API level. The prompt still forbids tool
 * use in prose as a belt-and-suspenders measure.
 */
function buildRecapPrompt(spanLength: number, lastUserQuery?: string): string {
  const topicLine = lastUserQuery
    ? `\n- **User's latest query**: "${lastUserQuery}" — mention it if it shaped the work.`
    : '';

  return `[RECAP] Collapse the conversation back to the brief that opens the last ${spanLength} message(s).

You have access to the FULL conversation history above. Only the messages AFTER that brief are about to be deleted and replaced by your summary — the brief itself and everything before it stays in context, so summarize that span alone and use the earlier messages strictly as background.

This is background for a mindmap decision, NOT the recap note: the note is written by the caller. Report what was learned so ONE mindmap node can be judged.

### Exploration Coverage
For EVERY file examined after the brief:
- path → one-line key takeaway (what was learned, found, or decided)
- Mark files that were ruled out as irrelevant with "(irrelevant)"

### Key Discoveries
Concrete findings with specificity: function names, line numbers, patterns identified, bugs found. Avoid vague descriptions.${topicLine}

**CRITICAL RULES:**
- The Exploration Coverage section is a "do not re-read" list — include every file
- Output TEXT ONLY — do NOT use any tools. No preamble, no sign-off.`;
}

/**
 * Generate recap summary using LLM.
 * Uses the FULL triologue messages (pre-truncation) with all tools for prompt cache.
 * Produces a structured summary string.
 * Does NOT touch the triologue — callers own the context manipulation.
 *
 * CACHE: fullMessages + allTools MUST be the un-minified, full-tools array the
 * main loop uses, so the fork hits the cached prefix. toolChoice:'none' is passed
 * to constrain output to text-only without invalidating that cache (it is a
 * sampling parameter, not part of the cached token sequence). See the CACHE
 * INVARIANT on buildRecapPrompt for the full rationale.
 *
 * @param fullMessages - Full triologue messages before truncation (cache prefix)
 * @param span - The messages the rewind will delete; the summary covers ONLY these
 * @param allTools - All tools for prompt cache preservation
 * @param escAware - Optional ESC-aware wrapper for lead agent
 * @param lastUserQuery - The user's most recent query, embedded as context
 *                         (not a steering directive) after the summary.
 * @returns the `additionalMessage` half of the recap note — the triologue
 *          prepends the [RECAP] header and the quoted anchor brief.
 */
/**
 * @deprecated NO PRODUCTION CALLER. `states/hook.ts` now uses `handleRecapSpan`
 * plus the model's own verbatim `summary`, so this summarization fork is dead
 * code kept only for the source-level emptiness test. Deleting it and that test
 * together is the follow-up; see src/tests/loop/states/recap-rewind-empty-summary.test.ts.
 */
export async function handleRecap(
  fullMessages: Message[],
  span: Message[],
  allTools: Tool[],
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
  lastUserQuery?: string,
): Promise<string> {
  if (fullMessages.length === 0) {
    return '[RECAP] No messages to summarize.';
  }

  const recapPrompt = buildRecapPrompt(span.length, lastUserQuery);

  let summary: string;
  if (escAware) {
    // Lead agent: use ESC-aware forkChat.
    // toolChoice:'none' constrains output to text-only WITHOUT touching the
    // cached prefix (it's a sampling param, not part of the cached token
    // sequence) — see the CACHE INVARIANT above.
    const result = await escAware(
      async (abortController) => {
        return await forkChat(fullMessages, allTools, recapPrompt, abortController.signal, 'none');
      },
      () => null as string | null
    );
    if (result === null) {
      return `[RECAP] Cancelled: ESC pressed during summarization. Nothing was collapsed — the span is still in context.`;
    }
    summary = result;
  } else {
    // Teammate: regular forkChat (no ESC handling). Same toolChoice:'none'
    // rationale as the lead branch.
    summary = await forkChat(fullMessages, allTools, recapPrompt, undefined, 'none');
  }

  // NO placeholder substitution here. An empty fork result stays empty.
  // NOTE: this function is unreachable from production (see @deprecated above), so
  // it is NOT what protects the span — the floor in states/hook.ts refuses a short
  // or empty summary on the live path. The rule is kept here so the legacy helper
  // cannot start substituting a placeholder if it is ever revived.
  summary = summary.trim();

  // Assemble the `additionalMessage` half of the recap note.
  // ORDERING (matters for LLM direction-following):
  // The bare `[RECAP]` header + quoted anchor brief are prepended by
  // Triologue.rewindToLastBrief() (it captures the anchor text BEFORE the truncation
  // deletes the brief's own round-trip). The SUMMARY is the model's own text,
  // copied verbatim — nothing here paraphrases it. Only context the deleted
  // span held but the summary cannot restate is appended after it:
  //   1. recap-summary    — verbatim (the model's record of what was found)
  //   2. last-user-query  — context note: the user's most recent instruction
  const parts: string[] = [];
  parts.push('Some actions have been performed before this recap but the details have been omitted. Here is the summary:');
  parts.push('');
  parts.push(summary);
  if (lastUserQuery) {
    parts.push('');
    parts.push(`**User's last query (context):** ${lastUserQuery}`);
  }

  return parts.join('\n');
}

// ============================================================================
// MINDMAP PATCH: forkChat #2 — concurrent patch decision
//
// Each recap launches ONE forkChat call: the mindmap-patch decision
// (generatePatchAction, below). It decides whether ONE mindmap node should be
// added/updated/deleted.
//
// There is no summarization fork: since the two-field schema the note body is the
// model's OWN `summary`, copied verbatim by the caller. The fork still reuses the
// SAME triologue prefix the loop already paid for → same prompt-cache hit.
// See docs/mindmap/mindmap-redesign.md Part 2.
// ============================================================================

/** Maximum retry attempts for an invalid patch response (beyond the first try). */
const PATCH_MAX_RETRIES = 2;

/**
 * Generate a compact path-only outline of the mindmap tree for the patch prompt.
 * Marks each node [M] (MYCC.md-sourced, is_mycc=true) or [P] (patch-added).
 * Truncated to first 3 levels if the tree is large (> 200 nodes) to keep the
 * prompt size bounded.
 *
 * @param node - The root node to outline from
 * @returns Indented tree outline string with [M]/[P] markers and node ids
 */
function generateTreeOutline(node: Node): string {
  // Count total nodes; if large, truncate to first 3 levels
  function countNodes(n: Node): number {
    return 1 + n.children.reduce((acc, c) => acc + countNodes(c), 0);
  }
  const total = countNodes(node);
  const maxLevel = total > 200 ? 3 : Infinity;

  const lines: string[] = [];
  function walk(n: Node, indent: string) {
    if (n.level > maxLevel) return;
    const marker = n.is_mycc ? '[M]' : '[P]';
    lines.push(`${indent}${marker} ${n.id}`);
    for (const child of n.children) {
      walk(child, `${indent}  `);
    }
  }
  walk(node, '');

  if (total > 200) {
    // Append a count of deeper nodes omitted
    let deeper = 0;
    function countDeeper(n: Node) {
      if (n.level > maxLevel) {
        deeper += countNodes(n);
        return;
      }
      for (const child of n.children) countDeeper(child);
    }
    countDeeper(node);
    if (deeper > 0) {
      lines.push(`  ... (${deeper} deeper nodes omitted)`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the patch-decision prompt for forkChat #2.
 *
 * This prompt is focused on a SINGLE objective: decide if ONE mindmap node
 * should be changed. The recap note is written by the CALLER, never here.
 * Output is either "none" or a single JSON object.
 *
 * @param treeOutline - The path-only tree outline (from generateTreeOutline)
 * @param feedback - Optional validation error feedback from a prior invalid response
 * @returns The assembled prompt string
 */
function buildPatchPrompt(treeOutline: string, feedback: string): string {
  return `[MINDMAP PATCH] You just completed a recap.
Review the conversation history since the brief that opened this recap.

Here is the current mindmap tree (paths only, [M] = MYCC.md-sourced, [P] = patch-added):
${treeOutline}

Based on what was learned during this recap span, decide if ONE mindmap node should be changed.
You may choose ONE of:
- ADD: add a child node to an existing parent (provide path=parent_path, title, text)
- UPDATE: update an existing node's text (provide path=target_path, text)
- DELETE: delete an existing non-root node (provide path=target_path)

Rules:
- For ADD: path MUST be an existing node (the parent)
- For UPDATE/DELETE: path MUST be an existing node (the target), not root
- Only make a change if genuinely warranted by new discoveries
- Be conservative — the mindmap is shared knowledge

If no change is warranted, respond exactly: none

Otherwise, respond with ONE JSON object (no other text):
{"action":"add|update|delete","path":"/...","title":"...","text":"...","reason":"..."}
${feedback}
Output TEXT ONLY — do NOT use any tools.`;
}

/**
 * Parsed result of a patch response.
 */
interface ParsedPatchResponse {
  /** The validated patch action, or null if "none" / no patch warranted */
  patch: MindmapPatchAction | null;
  /** Validation error message (for retry feedback); undefined when valid */
  error?: string;
}

/**
 * Parse and validate the forkChat #2 patch response against the current mindmap.
 *
 * Validation rules:
 * - "none" or empty → no patch (valid, patch=null)
 * - Must be valid JSON with action in {add, update, delete}
 * - 'add': path must be an existing node (parent), title + text required
 * - 'update': path must be an existing non-root node, text required
 * - 'delete': path must be an existing non-root node
 *
 * @param response - The raw LLM response text
 * @param mindmap - The current mindmap (for path validation)
 * @returns ParsedPatchResponse with either a valid patch, null (none), or an error
 */
export function parsePatchResponse(
  response: string,
  mindmap: Mindmap,
): ParsedPatchResponse {
  const trimmed = response.trim();

  // 1. "none" case
  if (trimmed.toLowerCase() === 'none' || trimmed === '') {
    return { patch: null };
  }

  // 2. Parse JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { patch: null, error: `Response is not valid JSON: "${trimmed.slice(0, 100)}"` };
  }

  // 3. Validate action type
  const action = parsed.action;
  if (action !== 'add' && action !== 'update' && action !== 'delete') {
    return { patch: null, error: `Invalid action "${String(action)}". Must be add, update, or delete.` };
  }

  // 4. Validate path
  const path = parsed.path;
  if (typeof path !== 'string' || path.length === 0) {
    return { patch: null, error: 'Missing or invalid "path" field.' };
  }

  const targetNode = get_node(mindmap, path);

  if (action === 'add') {
    if (!targetNode) {
      return { patch: null, error: `Parent node not found: "${path}"` };
    }
    const title = parsed.title;
    if (typeof title !== 'string' || title.length === 0) {
      return { patch: null, error: 'ADD requires a non-empty "title" field.' };
    }
    const text = parsed.text;
    if (typeof text !== 'string') {
      return { patch: null, error: 'ADD requires a "text" field.' };
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    return {
      patch: {
        action: 'add',
        path,
        title,
        text,
        timestamp: new Date().toISOString(),
        reason,
        mindmap_hash: mindmap.hash,
      },
    };
  }

  // action === 'update' or 'delete'
  if (!targetNode) {
    return { patch: null, error: `Target node not found: "${path}"` };
  }
  if (targetNode === mindmap.root) {
    return { patch: null, error: 'Cannot update or delete root node.' };
  }

  if (action === 'update') {
    const text = parsed.text;
    if (typeof text !== 'string') {
      return { patch: null, error: 'UPDATE requires a "text" field.' };
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    return {
      patch: {
        action: 'update',
        path,
        text,
        timestamp: new Date().toISOString(),
        reason,
        mindmap_hash: mindmap.hash,
      },
    };
  }

  // action === 'delete'
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  return {
    patch: {
      action: 'delete',
      path,
      timestamp: new Date().toISOString(),
      reason,
      mindmap_hash: mindmap.hash,
    },
  };
}

/**
 * forkChat #2 — generate a patch decision concurrently with the recap summary.
 *
 * Forks the triologue prefix the loop already paid for (prompt-cache hit). Has
 * its own retry loop (up to PATCH_MAX_RETRIES additional attempts) for invalid
 * responses. If ESC is pressed (lead agent) it THROWS StreamAbortedError — an
 * explicit cancellation, because plain `null` means "the model said none" and
 * must not be confused with it.
 *
 * CACHE: same rationale as handleRecap — fullMessages + allTools must be the
 * un-minified, full-tools array so the fork hits the cached prefix. toolChoice
 * 'none' constrains output to text-only without invalidating the cache.
 *
 * @param fullMessages - Full triologue messages before truncation (cache prefix)
 * @param allTools - All tools for prompt cache preservation
 * @param mindmap - Current mindmap (for tree outline + path validation)
 * @param escAware - Optional ESC-aware wrapper (lead agent); teammates omit it
 * @returns A validated MindmapPatchAction, or null if none/invalid/retries exhausted
 * @throws StreamAbortedError when the user pressed ESC
 */
export async function generatePatchAction(
  fullMessages: Message[],
  allTools: Tool[],
  mindmap: Mindmap,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<MindmapPatchAction | null> {
  let feedback = '';

  for (let attempt = 0; attempt <= PATCH_MAX_RETRIES; attempt++) {
    const treeOutline = generateTreeOutline(mindmap.root);
    const prompt = buildPatchPrompt(treeOutline, feedback);

    let response: string;
    if (escAware) {
      const result = await escAware(
        async (ac) => forkChat(fullMessages, allTools, prompt, ac.signal, 'none'),
        () => null as string | null,
      );
      // ESC IS AN OUTCOME, NOT "NO PATCH". Returning null here made a cancelled
      // recap indistinguishable from "the model said none" — and the caller then
      // truncated the span the user had just asked to keep. Throwing routes it
      // into handleRecapSpan's catch, which reports it as `escCancelled`.
      if (result === null) throw new StreamAbortedError('[RECAP] ESC pressed during the mindmap patch');
      response = result;
    } else {
      response = await forkChat(fullMessages, allTools, prompt, undefined, 'none');
    }

    const parsed = parsePatchResponse(response, mindmap);
    if (!parsed.error) {
      return parsed.patch;  // valid (including null = "none")
    }

    // Invalid — prepare feedback for next retry
    feedback = `\n\n**Your previous response was invalid:**\n${parsed.error}\nPlease fix and respond again with either "none" or a valid JSON object.`;
  }

  // All retries exhausted — no patch
  return null;
}

/** What `handleRecapSpan` reports: the patch decision and its cancellation state. */
export interface RecapWithPatchResult {
  /** The mindmap patch decision. The recap NOTE is not produced here: the
   *  model's own summary is copied verbatim by the caller. */
  /** A validated patch action, or null if none was produced (from forkChat #2) */
  patch: MindmapPatchAction | null;
  /**
   * Non-null when the mindmap-patch fork failed. The patch is best-effort, so
   * this never fails the recap — but it must not vanish silently either: the
   * jsonl-validation failure is reported via `brief('warn', 'mindmap-patch')`,
   * so a dropped patch deserves the same visibility. Reported by the CALLER
   * (hook.ts), not from here: agentIO is process-wide and this module is also
   * used by teammate recaps.
   */
  patchError: string | null;
  /**
   * TRUE when the user pressed ESC during the patch fork. The caller MUST refuse
   * the rewind: the span is still in context and the user asked to stop, so
   * collapsing it would delete work they were trying to save.
   */
  escCancelled: boolean;
}

/**
 * Run the ONE surviving fork: the mindmap-patch decision.
 *
 * The note body is the model's own `summary`, copied verbatim by the caller, so no
 * summarization fork exists and nothing here needs Promise.all. If mindmap is
 * null/undefined the fork is skipped and `patch` is null.
 *
 * @param fullMessages - Full triologue messages before truncation (cache prefix)
 * @param allTools - All tools for prompt cache preservation
 * @param mindmap - Current mindmap (for patch decision); if absent, skip patch
 * @param escAware - Optional ESC-aware wrapper (lead agent)
 * @returns { patch, patchError, escCancelled } — the patch is best-effort; the
 *          cancellation flag is what the caller must honour before rewinding
 */
export async function handleRecapSpan(
  fullMessages: Message[],
  allTools: Tool[],
  mindmap: Mindmap | null | undefined,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<RecapWithPatchResult> {
  // ── SPINNER: the caller owns the wait indicator ──
  // forkChat is permanently noSpinner (see its header), so retryChat paints
  // NOTHING for these forks. Without a spinner here the terminal is silent for
  // the entire recap (~10-60s of LLM time) and mycc looks hung even though the
  // two forks are running normally. This is the same contract crossroad.ts
  // follows: one startSpinner/stopSpinner pair around the fork group.
  //
  // ONE pair for BOTH forks — not one per fork. The spinner is a NON-refcounted
  // module-global (chat-helpers.ts): a second startSpinner while one is running
  // is a no-op, and stopSpinner by whichever fork finished first would clear the
  // line while the other is still streaming. Wrapping each fork individually
  // would make the spinner die mid-recap.
  //
  // The forks are already safe to reveal visually: updateSpinnerTokens() is
  // called unconditionally by the providers' onChunk (it is NOT gated by
  // noSpinner), so the live "(Xs, N tokens)" suffix works here for free.
  // finally{} guarantees the line is cleared on success, on ESC (escAware
  // resolves null — it only logs verbosely, so the spinner never hides an ESC
  // hint) and on a thrown error.
  startSpinner('Recapping context');
  let patch: MindmapPatchAction | null;
  // Set by the patch fork's catch — surfaced to the caller, never fatal.
  let patchError: string | null = null;
  /**
   * TRUE only when the user actually pressed ESC during the patch fork.
   *
   * NOT derivable from `patchError`: any aborted stream raises StreamAbortedError,
   * including the teammate watchdog, so the error alone cannot tell a cancellation
   * from a provider hiccup. Neglected mode is the ESC channel.
   */
  let escCancelled = false;
  try {
    // ── The lone surviving fork: the mindmap-patch decision ──
    // The note body is the model's own `summary` (copied verbatim by the caller),
    // so there is no summary fork to run — and therefore no Promise.all: a lone
    // fork needs no concurrency scaffolding, and the spinner still wraps the wait.
    //
    // REJECTION POLICY: a mindmap patch is BEST-EFFORT. Letting it reject would
    // dump the turn to PROMPT after the user already waited, so it is neutralised
    // to `null` — and `.catch` must RETURN a value for that; a logging-only handler
    // still leaves the rejection to propagate.
    patch = mindmap
      ? await generatePatchAction(fullMessages, allTools, mindmap, escAware).catch((err: unknown) => {
          // REACHABILITY: this branch is live but NARROW. escAware races
          // forkChat against an ESC resolver (parent/core.ts:747); abort() fires
          // synchronously (:724) while the sentinel resolves only after
          // `await onCleanUp()` (:725), so forkChat usually rejects FIRST and
          // the summary fork's rejection reaches the caller instead of the
          // "[RECAP] Cancelled:" sentinel. The race is per-fork, so
          // "summary resolves with the sentinel, patch rejects" is reachable —
          // that interleaving is this handler's only entry point.
          //
          // StreamAbortedError does NOT mean "the recap is cancelled": any
          // aborted stream raises it, including the teammate watchdog
          // (context/teammate-worker.ts). So it is reported like any other
          // patch failure, only shorter.
          patchError = err instanceof StreamAbortedError
            ? 'mindmap-patch fork aborted'
            : `mindmap-patch fork failed: ${String(err)}`;
          // A StreamAbortedError WHILE neglected mode is on is a real cancellation;
          // anything else (watchdog, provider fault) is a failed patch that must
          // not block a valid recap.
          escCancelled = err instanceof StreamAbortedError && agentIO.isNeglectedMode();
          return null;
        })
      : null;
  } finally {
    // Cleared on success, on ESC, and on a thrown error. A still-running
    // sibling keeps streaming into a stopped spinner, which is harmless
    // (startSpinner is non-refcounted; stopSpinner only clears the line).
    stopSpinner();
  }

  return { patch, patchError, escCancelled };
}

