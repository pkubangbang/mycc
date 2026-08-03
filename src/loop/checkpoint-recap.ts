/**
 * checkpoint-recap.ts - Shared checkpoint and recap logic
 *
 * Used by both lead agent (hook.ts) and teammate agents (teammate-worker.ts).
 * These are meta-tools that need triologue access for message management.
 */

import chalk from 'chalk';
import type { Message, TodoModule, Tool } from '../types.js';
import type { Mindmap, MindmapPatchAction, Node } from '../mindmap/types.js';
import { get_node } from '../mindmap/get-node.js';
import { Triologue } from './triologue.js';
import { forkChat } from '../engine/chat-provider.js';

/**
 * Core module interface (common between AgentContext and ChildContext)
 */
interface CoreModule {
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string): void;
}

/**
 * Context interface for checkpoint/recap handlers
 */
export interface CheckpointContext {
  core: CoreModule;
  triologue: Triologue;
  todo: TodoModule;
}

/**
 * Result from checkpoint creation
 */
export interface CheckpointResult {
  success: boolean;
  result: string;
  id: string;
  description: string;
  ifAbandoned: string;
}

/**
 * Validate that checkpoint is called alone (no other tools in same turn)
 */
export function validateCheckpointIsolation(toolCalls: Array<{ function: { name: string } }>): { valid: boolean; message?: string } {
  const hasCheckpoint = toolCalls.some(c => c.function.name === 'checkpoint');
  if (!hasCheckpoint) {
    return { valid: true };
  }
  
  if (toolCalls.length > 1) {
    return {
      valid: false,
      message: 'Checkpoint must be called alone. Other tools cannot be used in the same turn.',
    };
  }
  
  return { valid: true };
}

/**
 * Validate that recap is called alone (no other tools in same turn)
 */
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
 * Handle checkpoint meta-tool
 * Creates a checkpoint marker in the message history.
 * NOTE: Does NOT add the checkpoint marker - that's done by the caller after tool response.
 */
export function handleCheckpoint(
  args: Record<string, unknown>,
  ctx: CheckpointContext
): CheckpointResult {
  const triologue = ctx.triologue;
  const description = args.description as string;
  const ifAbandoned = args.if_abandoned as string;

  if (!description || typeof description !== 'string' || description.trim() === '') {
    return { 
      success: false, 
      result: 'Error: description is required and must be a non-empty string.', 
      id: '', 
      description: '',
      ifAbandoned: '',
    };
  }

  if (!ifAbandoned || typeof ifAbandoned !== 'string' || ifAbandoned.trim() === '') {
    return {
      success: false,
      result: 'Error: if_abandoned is required and must be a non-empty string. Declare your original direction so recap-abandon has continuity context.',
      id: '',
      description: '',
      ifAbandoned: '',
    };
  }

  // Check for existing open checkpoint
  const existingCheckpoint = triologue.findOpenCheckpoint();
  if (existingCheckpoint) {
    return { 
      success: false,
      result: `Error: Checkpoint already exists: ${existingCheckpoint.id} "${existingCheckpoint.description}". Call recap first to close it, or remove it if abandoned.`, 
      id: '', 
      description: '',
      ifAbandoned: '',
    };
  }

  // Generate checkpoint ID
  const id = Triologue.generateCheckpointId();

  // Auto-create a todo item tracking this checkpoint
  ctx.todo.createTodo(`Checkpoint: ${description}`, id);

  // Get context length at checkpoint creation
  const tokenCount = triologue.getTokenCount();
  const tokenThreshold = triologue.getTokenThreshold();
  const usagePercent = Math.round((tokenCount / tokenThreshold) * 100);

  // Capture "before" state: last user query and recent assistant context
  const lastUserQuery = triologue.getLastUserQuery();
  const rawMessages = triologue.getMessagesRaw();
  let recentAssistantContext = '';
  // Scan backwards from the end to find the last assistant message with content
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (msg.role === 'assistant' && msg.content && msg.content.trim()) {
      // Take up to 200 chars of the last assistant response for context
      const truncated = msg.content.length > 200
        ? `${msg.content.slice(0, 200)}...`
        : msg.content;
      recentAssistantContext = truncated;
      break;
    }
  }

  // Build the "before state" section
  const beforeStateParts: string[] = [];
  beforeStateParts.push('### Current State (at checkpoint creation)');
  if (lastUserQuery) {
    beforeStateParts.push(`**Last user instruction**: "${lastUserQuery}"`);
  }
  if (recentAssistantContext) {
    beforeStateParts.push(`**Recent context**: ${recentAssistantContext}`);
  }
  beforeStateParts.push('');
  beforeStateParts.push(`**Exploration Goal**: ${description}`);
  const beforeStateSection = beforeStateParts.join('\n');

  // Brief the user (simple, colorized)
  const coloredId = chalk.cyan.bold(id);
  const coloredTokens = chalk.yellow(`${tokenCount.toLocaleString()}`);
  const coloredThreshold = chalk.gray(`${tokenThreshold.toLocaleString()}`);
  ctx.core.brief('info', 'checkpoint',
    `${description} (${coloredTokens}/${coloredThreshold} tokens)`,
    `id: ${coloredId}`
  );

  return {
    success: true,
    result: `Checkpoint created: ${id}

Description: ${description}
Original direction: ${ifAbandoned}
Context: ${tokenCount} / ${tokenThreshold} tokens (${usagePercent}%)

${beforeStateSection}

Next steps:
1. Perform your subtask (read files, run commands, etc.)
2. When done, call recap({ checkpoint_id: "${id}" }) to compress messages into a summary`,
    id,
    description,
    ifAbandoned,
  };
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
function buildRecapPrompt(description: string, lastUserQuery?: string, comment?: string, checkpointResult?: string): string {
  const topicLine = lastUserQuery
    ? `\n- **User's latest query**: "${lastUserQuery}" — compare with the checkpoint description; if they diverge, flag a topic change.`
    : '';

  // Extract the "before state" section from the checkpoint result if available
  let beforeStateSection = '';
  if (checkpointResult) {
    const beforeMatch = checkpointResult.match(/### Current State \(at checkpoint creation\)[\s\S]*?(?=\n\nNext steps:|$)/);
    if (beforeMatch) {
      beforeStateSection = `\n### Before State (captured at checkpoint creation)\n${beforeMatch[0].trim()}\n\nCompare this "before" state with what was actually found during exploration. Did the exploration stay on track? Were there any topic changes or unexpected discoveries?\n`;
    }
  }

  return `[RECAP] Close the checkpoint "${description}". You have access to the full conversation history above.

Review everything from when the checkpoint was created up to this recap call. Produce a concise structured note covering:

### Exploration Coverage
For EVERY file examined during this checkpoint span:
- path → one-line key takeaway (what was learned, found, or decided)
- Mark files that were ruled out as irrelevant with "(irrelevant)"
This section serves as a "do not re-read" list for subsequent turns.

### Key Discoveries
Concrete findings with specificity: function names, line numbers, patterns identified, bugs found. Avoid vague descriptions.

### Current State
What the agent now knows that it did NOT know before the checkpoint. This MUST be detailed enough that subsequent turns do NOT need to re-verify or re-investigate any findings already made. Think of this as the agent's updated "mental model" after the exploration.

### Next Steps
What still needs to be done, ordered by priority.${topicLine}
${comment ? `\n**Direction comment (provided, will be placed last as the steering directive):** "${comment}" — make the Next Steps consistent with this direction.` : ''}
${beforeStateSection}
**CRITICAL RULES:**
- The Exploration Coverage section is a "do not re-read" list — include every file
- The Current State section is a "do not re-verify" record — be specific
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
 * @param fullMessages - Full triologue messages before truncation
 * @param allTools - All tools for prompt cache preservation
 * @param description - Checkpoint description (focus for summarization)
 * @param escAware - Optional ESC-aware wrapper for lead agent
 * @param comment - REQUIRED for non-abandon recaps. The agent's directive that
 *                   determines the direction of the next turn; placed LAST in the
 *                   assembled note so it is the final steering instruction.
 * @param lastUserQuery - The user's most recent query, embedded as context
 *                         (not a steering directive) between summary and comment.
 * @param checkpointResult - The original checkpoint tool result (for "before state" context)
 */
export async function handleRecap(
  fullMessages: Message[],
  allTools: Tool[],
  description: string,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
  comment?: string,
  lastUserQuery?: string,
  checkpointResult?: string,
): Promise<string> {
  if (fullMessages.length === 0) {
    return '[RECAP] No messages to summarize.';
  }

  const recapPrompt = buildRecapPrompt(description, lastUserQuery, comment, checkpointResult);

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
      return `[RECAP] Cancelled: ESC pressed during summarization. Checkpoint "${description}" remains open.`;
    }
    summary = result;
  } else {
    // Teammate: regular forkChat (no ESC handling). Same toolChoice:'none'
    // rationale as the lead branch.
    summary = await forkChat(fullMessages, allTools, recapPrompt, undefined, 'none');
  }

  summary = summary || '(no summary)';

  // Build the compact note that replaces the entire checkpoint span.
  // ORDERING (matters for LLM direction-following):
  //   1. checkpoint-desc  — which checkpoint closed (anchor)
  //   2. recap-summary    — the structured summary body (what was found)
  //   3. last-user-query  — context note: the user's most recent instruction
  //                         (background, not the steering directive)
  //   4. recap-comment    — the agent's directive, placed LAST so it is the
  //                         final thing the conversation sees before continuing.
  //                         This is the most important field: it decides the
  //                         direction of the next turn.
  const parts: string[] = [];
  parts.push(`[RECAP] Checkpoint "${description}" closed.`);
  parts.push('');
  parts.push('Some actions have been performed before this recap but the details have been omitted. Here is the summary:');
  parts.push('');
  parts.push(summary);
  if (lastUserQuery) {
    parts.push('');
    parts.push(`**User's last query (context):** ${lastUserQuery}`);
  }
  if (comment) {
    parts.push('');
    parts.push(`**Next direction (recap comment — follow this):** ${comment}`);
  }

  return parts.join('\n');
}

// addCheckpointMarker removed — checkpoint is now identified via tool message
// (see isCheckpointMessage in triologue.ts)

// ============================================================================
// MINDMAP PATCH: forkChat #2 — concurrent patch decision
//
// Each recap launches TWO concurrent forkChat calls via Promise.all (see
// handleRecapWithPatch). forkChat #1 (handleRecap, unchanged) produces the
// recap summary. forkChat #2 (generatePatchAction, below) independently
// decides whether ONE mindmap node should be added/updated/deleted.
//
// Both calls fork from the SAME triologue messages → same prompt-cache prefix.
// Neither depends on the other's output. See docs/mindmap-redesign.md Part 2.
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
      walk(child, indent + '  ');
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
 * should be changed. It does NOT mix in summarization (that's forkChat #1's
 * job). Output is either "none" or a single JSON object.
 *
 * @param description - The checkpoint description (focus context)
 * @param treeOutline - The path-only tree outline (from generateTreeOutline)
 * @param feedback - Optional validation error feedback from a prior invalid response
 * @returns The assembled prompt string
 */
function buildPatchPrompt(description: string, treeOutline: string, feedback: string): string {
  return `[MINDMAP PATCH] You just completed a checkpoint: "${description}".
Review the conversation history from when the checkpoint was created up to now.

Here is the current mindmap tree (paths only, [M] = MYCC.md-sourced, [P] = patch-added):
${treeOutline}

Based on what was learned during this checkpoint, decide if ONE mindmap node should be changed.
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
 * @param checkpointId - The checkpoint id to record in the patch
 * @returns ParsedPatchResponse with either a valid patch, null (none), or an error
 */
function parsePatchResponse(
  response: string,
  mindmap: Mindmap,
  checkpointId: string,
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
        checkpoint_id: checkpointId,
        reason,
        mindmap_hash: mindmap.hash,
      },
    };
  }

  // action === 'update' or 'delete'
  if (!targetNode) {
    return { patch: null, error: `Target node not found: "${path}"` };
  }
  if (path === '/' || path === '') {
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
        checkpoint_id: checkpointId,
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
      checkpoint_id: checkpointId,
      reason,
      mindmap_hash: mindmap.hash,
    },
  };
}

/**
 * forkChat #2 — generate a patch decision concurrently with the recap summary.
 *
 * Forks from the same triologue messages as forkChat #1. Has its own retry
 * loop (up to PATCH_MAX_RETRIES additional attempts) for invalid responses.
 * If ESC is pressed (lead agent), returns null immediately (skip patch).
 *
 * CACHE: same rationale as handleRecap — fullMessages + allTools must be the
 * un-minified, full-tools array so the fork hits the cached prefix. toolChoice
 * 'none' constrains output to text-only without invalidating the cache.
 *
 * @param fullMessages - Full triologue messages before truncation (shared with #1)
 * @param allTools - All tools for prompt cache preservation (shared with #1)
 * @param description - Checkpoint description (focus context)
 * @param mindmap - Current mindmap (for tree outline + path validation)
 * @param checkpointId - The checkpoint id being closed
 * @param escAware - Optional ESC-aware wrapper (lead agent); teammates omit it
 * @returns A validated MindmapPatchAction, or null if none/invalid/ESC
 */
export async function generatePatchAction(
  fullMessages: Message[],
  allTools: Tool[],
  description: string,
  mindmap: Mindmap,
  checkpointId: string,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<MindmapPatchAction | null> {
  let feedback = '';

  for (let attempt = 0; attempt <= PATCH_MAX_RETRIES; attempt++) {
    const treeOutline = generateTreeOutline(mindmap.root);
    const prompt = buildPatchPrompt(description, treeOutline, feedback);

    let response: string;
    if (escAware) {
      const result = await escAware(
        async (ac) => forkChat(fullMessages, allTools, prompt, ac.signal, 'none'),
        () => null as string | null,
      );
      if (result === null) return null;  // ESC pressed — skip patch
      response = result;
    } else {
      response = await forkChat(fullMessages, allTools, prompt, undefined, 'none');
    }

    const parsed = parsePatchResponse(response, mindmap, checkpointId);
    if (!parsed.error) {
      return parsed.patch;  // valid (including null = "none")
    }

    // Invalid — prepare feedback for next retry
    feedback = `\n\n**Your previous response was invalid:**\n${parsed.error}\nPlease fix and respond again with either "none" or a valid JSON object.`;
  }

  // All retries exhausted — no patch
  return null;
}

/**
 * Result of handleRecapWithPatch: the recap summary + optional patch action.
 */
export interface RecapWithPatchResult {
  /** The structured recap summary note (from forkChat #1) */
  summary: string;
  /** A validated patch action, or null if none was produced (from forkChat #2) */
  patch: MindmapPatchAction | null;
}

/**
 * Run both forkChat calls concurrently via Promise.all.
 *
 * - forkChat #1 (handleRecap): recap summary — unchanged from existing behavior.
 * - forkChat #2 (generatePatchAction): patch decision — independent, concurrent.
 *
 * Both fork from the same triologue messages (shared prompt-cache prefix).
 * Neither receives the other's output. If mindmap is null/undefined, forkChat
 * #2 is skipped (returns null) and only the summary runs.
 *
 * Note on retries: if forkChat #2's first response is invalid, its retry loop
 * runs after Promise.all resolves the first attempt — by then forkChat #1 has
 * already completed. This is acceptable because retries are rare (the patch
 * prompt is simple) and the summary is already available for the caller.
 *
 * @param fullMessages - Full triologue messages before truncation
 * @param allTools - All tools for prompt cache preservation
 * @param description - Checkpoint description
 * @param mindmap - Current mindmap (for patch decision); if absent, skip patch
 * @param checkpointId - The checkpoint id being closed
 * @param escAware - Optional ESC-aware wrapper (lead agent)
 * @param comment - REQUIRED for non-abandon recaps (steering directive)
 * @param lastUserQuery - The user's most recent query (context, not directive)
 * @param checkpointResult - The original checkpoint tool result (before-state)
 * @returns { summary, patch } — summary always present, patch may be null
 */
export async function handleRecapWithPatch(
  fullMessages: Message[],
  allTools: Tool[],
  description: string,
  mindmap: Mindmap | null | undefined,
  checkpointId: string,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
  comment?: string,
  lastUserQuery?: string,
  checkpointResult?: string,
): Promise<RecapWithPatchResult> {
  // ── Launch both forkChats concurrently via Promise.all ──
  // Both fork from the same triologue messages — neither depends on the other's output.
  const [summary, patch] = await Promise.all([
    // forkChat #1: Recap Summary (unchanged from current handleRecap)
    handleRecap(fullMessages, allTools, description, escAware, comment, lastUserQuery, checkpointResult),
    // forkChat #2: Patch Decision (independent, concurrent) — skip if no mindmap
    mindmap
      ? generatePatchAction(fullMessages, allTools, description, mindmap, checkpointId, escAware)
      : Promise.resolve(null),
  ]);

  return { summary, patch };
}

