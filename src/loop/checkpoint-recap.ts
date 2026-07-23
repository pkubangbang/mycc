/**
 * checkpoint-recap.ts - Shared checkpoint and recap logic
 *
 * Used by both lead agent (hook.ts) and teammate agents (teammate-worker.ts).
 * These are meta-tools that need triologue access for message management.
 */

import chalk from 'chalk';
import type { Message, TodoModule, Tool } from '../types.js';
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

  if (!description || typeof description !== 'string' || description.trim() === '') {
    return { 
      success: false, 
      result: 'Error: description is required and must be a non-empty string.', 
      id: '', 
      description: '' 
    };
  }

  // Check for existing open checkpoint
  const existingCheckpoint = triologue.findOpenCheckpoint();
  if (existingCheckpoint) {
    return { 
      success: false,
      result: `Error: Checkpoint already exists: ${existingCheckpoint.id} "${existingCheckpoint.description}". Call recap first to close it, or remove it if abandoned.`, 
      id: '', 
      description: '' 
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
Context: ${tokenCount} / ${tokenThreshold} tokens (${usagePercent}%)

${beforeStateSection}

Next steps:
1. Perform your subtask (read files, run commands, etc.)
2. When done, call recap({ checkpoint_id: "${id}" }) to compress messages into a summary`,
    id,
    description,
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

