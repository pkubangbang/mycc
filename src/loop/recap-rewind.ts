/**
 * recap-rewind.ts - The FORK half of an automatic fold.
 *
 * Folding used to be a META-TOOL (`recap`): its definition shipped for LLM
 * visibility, its real work lived in the state machine, and a guard forced the
 * model to call it alone. The model never called it, so the decision moved out
 * of the conversation entirely (`recap-signal.ts`, docs/loop/auto-recap-plan.md):
 *
 *     brief turn ──> signal (retryChat over the brief list) ──"recap"──> THIS MODULE
 *                                                                         │
 *                                    ┌────────────────────────────────────┤
 *                                    ▼                                    ▼
 *                     forkChat: summarize the span      forkChat: ONE mindmap patch
 *
 * The rewind itself (truncate at the anchor + write the note) belongs to the
 * triologue facade — `Triologue.rewindToLastBrief()` — and is NOT re-implemented
 * here. This module only produces the two pieces of TEXT a fold needs, from the
 * pre-rewind conversation used as the cached prefix, and reports what happened.
 *
 * ONE SPINNER PAIR FOR BOTH FORKS: `forkChat` is permanently noSpinner (see its
 * header), so nothing would paint a wait indicator during 10-60s of LLM time.
 * A single `startSpinner`/`stopSpinner` pair wraps the group — not one pair per
 * fork — because the spinner is a non-refcounted module-global: a second start is
 * a no-op and the first finish would clear the line while the other still runs.
 */

import type { Message, Tool } from '../types.js';
import type { Mindmap, MindmapPatchAction, Node } from '../mindmap/types.js';
import { get_node } from '../mindmap/get-node.js';
import { forkChat } from '../engine/chat-provider.js';
import { StreamAbortedError } from '../engine/chat-helpers.js';
import { agentIO } from './agent-io.js';
import { startSpinner, stopSpinner } from '../engine/chat-helpers.js';
import { MIN_RECAP_SUMMARY_CHARS } from './states/hook.js';

// ============================================================================
// MINDMAP PATCH: fork #2 — one node add/update/delete per fold
//
// Every fold launches ONE mindmap-patch forkChat (generatePatchAction, below)
// alongside the span summary. The two are independent: the summary describes what
// was folded, the patch decides whether the knowledge tree should change because
// of it. Both reuse the SAME triologue prefix the loop already paid for, so both
// are prompt-cache hits.
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
 * CACHE INVARIANT: fullMessages + allTools must be the un-minified, full-tools
 * array the main loop already paid for, so this fork hits the cached prefix
 * (system + projectContext + messages + full tools schema). Minifying rewrites the
 * sequence → cache miss; dropping the tools array drops cached tokens → cache miss;
 * either forces a full recompute of the whole conversation. `toolChoice: 'none'`
 * is a sampling parameter, not part of the cached token sequence, so it constrains
 * the output to text-only WITHOUT invalidating the cache.
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
      // truncated the span the user had just asked to keep. Throwing surfaces it
      // to handleRecapForks' catch, which reports it as `escCancelled`.
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

// ============================================================================
// THE FOLD: summarize the span (+ render its checklist) + mindmap patch
// ============================================================================

/**
 * The summary prompt. It is APPENDED to the conversation prefix (forkChat puts
 * it on the last user message), so the model sees the span it must summarize.
 *
 * The contract is narrow on purpose: the note REPLACES the span in the model's
 * context, so it must be a usable state statement in one read — and must not
 * restate raw tool output, which is what the fold removes.
 */
function buildSummaryPrompt(): string {
  return `[AUTO-RECAP] The work above this point is finished and is about to be REMOVED from your context. Write the note that replaces it.

Rules:
- State what was FOUND, what NOW HOLDS, and HOW THE NEXT TURN SHOULD PROCEED. That is the whole note.
- Keep every fact the next step depends on: file paths, function names, decisions and their reasons, commands that worked, errors that remain open, and anything the user asked for.
- Drop raw tool output, restated file contents, and narration of the steps themselves.
- Do not open with a preamble ("Here is a summary", "The user asked me to"). Do not use headings or bullet markers — 3 to 8 short sentences of plain prose.
- Write in the language of the conversation.
Output TEXT ONLY.`;
}

/** One fold's inputs, assembled by the caller (states/hook.ts step 4a). */
export interface RecapFoldInput {
  /** Pre-registration snapshot of the conversation — the prompt-cache prefix. */
  fullMessages: Message[];
  /** The FULL `main` tool list, un-minified: dropping or shrinking it costs the cache. */
  allTools: Tool[];
  /** Current mindmap, or null/undefined to skip the patch fork. */
  mindmap: Mindmap | null | undefined;

  /** How many chunks (brief-delimited spans) this fold collapses; drives the spinner text. */
  chunks: number;

  /**
   * The lead's ESC-aware runner. WITHOUT it the forks run uninterruptibly for
   * 1 + 3×10–60 s (summary, then up to three patch attempts) and the ESC is
   * only noticed afterwards — by which time the fold is discarded and the whole
   * wait was wasted. With it, each fork call is abortable and an ESC unwinds
   * immediately, reported as `escCancelled`.
   */
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>;
}

/** What a fold's forks produced. */
export interface RecapForkResult {
  /** The span summary, or null when the summary fork failed / returned nothing usable. */
  summary: string | null;
  /** Non-null when the summary fork failed for a reason worth reporting. */
  summaryError: string | null;
  /** The mindmap patch decision, or null for "none" / skipped / failed. */
  patch: MindmapPatchAction | null;
  /** Non-null when the patch fork failed. Best-effort: never blocks the fold. */
  patchError: string | null;
  /**
   * TRUE when the user pressed ESC. The caller MUST then fold NOTHING: the span
   * is still in context and the user asked to stop, so collapsing it would delete
   * work they were trying to save.
   */
  escCancelled: boolean;
}

/**
 * Run the forks for one fold.
 *
 * Both forks run CONCURRENTLY over the same prefix snapshot. The summary is
 * REQUIRED for a fold (there is no model behind it to retry by hand), so a
 * summary failure leaves the span intact; the patch is BEST-EFFORT.
 *
 * ESC is an OUTCOME, not "no summary": `escAware` resolves its cleanup value on
 * abort, and returning that as a failed fork would let the caller report a
 * cancellation as a shrug. It is tracked explicitly and checked at the end.
 */
export async function handleRecapForks(input: RecapFoldInput): Promise<RecapForkResult> {
  const { fullMessages, allTools, mindmap, chunks, escAware } = input;
  const chunkWord = chunks === 1 ? '1 chunk' : `${chunks} chunks`;
  startSpinner(`Summarizing last ${chunkWord}`);
  let summary: string | null = null;
  let summaryError: string | null = null;
  let patchError: string | null = null;
  let patch: MindmapPatchAction | null;

  try {
    const summaryTask = runSummaryFork(fullMessages, allTools, escAware)
      .catch((err: unknown) => {
        summaryError = err instanceof StreamAbortedError
          ? 'summary fork aborted'
          : `summary fork failed: ${describeCause(err)}`;
        return null;
      });

    const patchTask = mindmap
      ? generatePatchAction(fullMessages, allTools, mindmap, escAware).catch((err: unknown) => {
          patchError = err instanceof StreamAbortedError
            ? 'mindmap-patch fork aborted'
            : `mindmap-patch fork failed: ${describeCause(err)}`;
          return null;
        })
      : Promise.resolve(null);

    const [summaryText, patchDecision] = await Promise.all([summaryTask, patchTask]);
    patch = patchDecision;

    const text = (summaryText ?? '').trim();
    // The note REPLACES the span: an empty or stub-length summary would delete
    // everything after the brief and record nothing. Treated as a failed fold so
    // the span survives — there is no model to ask for a fuller one.
    if (text.length >= MIN_RECAP_SUMMARY_CHARS && !text.startsWith('[RECAP]')) {
      summary = text;
    } else if (!summaryError) {
      summaryError = `summary unusable (${text.length} chars)`;
    }
  } finally {
    // Cleared on success, on ESC, and on a thrown error.
    stopSpinner();
  }

  // ESC IS AN OUTCOME, not "no summary": escAware resolves its cleanup value on
  // abort, and treating that as a failed fork would report a cancellation as a
  // shrug. Both fork failures (`*Error === '... aborted'`, set by the catches
  // above) and neglected mode mean the same thing: fold nothing, tell the caller.
  const escCancelled =
    summaryError === 'summary fork aborted'
    || patchError === 'mindmap-patch fork aborted'
    || agentIO.isNeglectedMode();
  if (escCancelled) {
    agentIO.verbose('recap', `fold cancelled: ${summaryError ?? patchError ?? 'ESC'}`);
  }
  return { summary, summaryError, patch, patchError, escCancelled };
}

/**
 * The summary fork itself.
 *
 * With an `escAware` runner the call is abortable: the cleanup value (`null`) is
 * turned into a StreamAbortedError so a cancellation is DISTINGUISHABLE from
 * "the model returned nothing", which is what the caller needs to fold nothing.
 */
async function runSummaryFork(
  fullMessages: Message[],
  allTools: Tool[],
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<string | null> {
  const prompt = buildSummaryPrompt();
  if (!escAware) return forkChat(fullMessages, allTools, prompt, undefined, 'none');
  const result = await escAware(
    (ac) => forkChat(fullMessages, allTools, prompt, ac.signal, 'none'),
    () => null as string | null,
  );
  if (result === null) throw new StreamAbortedError('[RECAP] ESC pressed during the summary fork');
  return result;
}

/** One short cause string for a failed fork (a bare `String(err)` loses `name`). */
function describeCause(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Apply a mindmap patch and journal it.
 *
 * Kept next to the fork that produced it (it used to live inline in
 * states/hook.ts): the in-memory tree and the jsonl are updated together, and
 * the jsonl is the source of truth (the in-memory tree is rebuilt from it at
 * startup). See docs/mindmap/mindmap-redesign.md Part 2.6.
 *
 * @returns true when the patch was applied AND persisted.
 */
export function commitMindmapPatch(
  mindmap: Mindmap,
  patch: MindmapPatchAction,
  patchPath: string,
  apply: (mindmap: Mindmap, patch: MindmapPatchAction) => boolean,
  append: (patch: MindmapPatchAction, patchPath: string) => boolean,
): boolean {
  if (!apply(mindmap, patch)) return false;
  // append() returns false when structural validation refuses the action
  // (orphan-prevention gate). apply() already accepted it, so a false here is
  // logic drift between the two validators — the caller reports it.
  return append(patch, patchPath);
}
