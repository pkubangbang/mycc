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

Next steps:
1. Perform your subtask (read files, run commands, etc.)
2. When done, call recap({ checkpoint_id: "${id}" }) to compress messages into a summary`,
    id,
    description,
  };
}

/**
 * Build the summarization prompt, merged into the last user message of the
 * full triologue. Uses full context + allTools for prompt cache,
 * instructs LLM to output text only.
 */
function buildRecapPrompt(description: string, lastUserQuery?: string, comment?: string): string {
  const topicLine = lastUserQuery
    ? `\n- **User's latest query**: "${lastUserQuery}" — compare with the checkpoint description; if they diverge, flag a topic change.`
    : '';

  return `[RECAP] Close the checkpoint "${description}". You have access to the full conversation history above.

Review everything from when the checkpoint was created up to this recap call. Produce a concise structured note covering:

### Key Decisions
What was decided and why?

### Steps Taken
What tool calls were used and what did each contribute? Use a compact timeline like "read_file → grep → web_search → write_file".

### User's Intent
What was the user trying to achieve?${topicLine}

### Next Steps
What should the agent do now? If the user's latest query changed topics, note the shift and recommend alignment.
${comment ? `\n**LLM Comment:** "${comment}" — incorporate this insight into the summary.` : ''}

Output TEXT ONLY — do NOT use any tools. No preamble, no sign-off.`;
}

/**
 * Generate recap summary using LLM.
 * Uses the FULL triologue messages (pre-truncation) with all tools for prompt cache.
 * Produces a structured summary string.
 * Does NOT touch the triologue — callers own the context manipulation.
 *
 * @param fullMessages - Full triologue messages before truncation
 * @param allTools - All tools for prompt cache preservation
 * @param description - Checkpoint description (focus for summarization)
 * @param escAware - Optional ESC-aware wrapper for lead agent
 * @param comment - Optional LLM comment to incorporate
 * @param lastUserQuery - The user's most recent query, used to detect topic change
 */
export async function handleRecap(
  fullMessages: Message[],
  allTools: Tool[],
  description: string,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
  comment?: string,
  lastUserQuery?: string,
): Promise<string> {
  if (fullMessages.length === 0) {
    return '[RECAP] No messages to summarize.';
  }

  const recapPrompt = buildRecapPrompt(description, lastUserQuery, comment);

  let summary: string;
  if (escAware) {
    // Lead agent: use ESC-aware forkChat
    const result = await escAware(
      async (abortController) => {
        return await forkChat(fullMessages, allTools, recapPrompt, abortController.signal);
      },
      () => null as string | null
    );
    if (result === null) {
      return `[RECAP] Cancelled: ESC pressed during summarization. Checkpoint "${description}" remains open.`;
    }
    summary = result;
  } else {
    // Teammate: regular forkChat (no ESC handling)
    summary = await forkChat(fullMessages, allTools, recapPrompt);
  }

  summary = summary || '(no summary)';

  // Build the compact note that replaces the entire checkpoint span
  const parts: string[] = [];
  parts.push(`[RECAP] Checkpoint "${description}" closed.`);
  parts.push('');
  parts.push(summary);
  if (comment) {
    parts.push('');
    parts.push(`**LLM Comment:** ${comment}`);
  }

  return parts.join('\n');
}

// addCheckpointMarker removed — checkpoint is now identified via tool message
// (see isCheckpointMessage in triologue.ts)

