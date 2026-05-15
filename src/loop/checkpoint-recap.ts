/**
 * checkpoint-recap.ts - Shared checkpoint and recap logic
 *
 * Used by both lead agent (hook.ts) and teammate agents (teammate-worker.ts).
 * These are meta-tools that need triologue access for message management.
 */

import chalk from 'chalk';
import type { Message, TodoModule } from '../types.js';
import { Triologue } from './triologue.js';
import { retryChat, MODEL } from '../ollama.js';
import { minifyMessages } from '../utils/llm-chat-minifier.js';

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
 * Generate recap summary using LLM.
 * Pure function: takes messages and description, returns a summary string.
 * Does NOT touch the triologue — callers own the context manipulation.
 *
 * @param messages - Messages from checkpoint to current end
 * @param description - Checkpoint description (focus for summarization)
 * @param escAware - Optional ESC-aware wrapper for lead agent
 * @param comment - Optional user comment to append to the summary
 */
export async function handleRecap(
  messages: Message[],
  description: string,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
  comment?: string,
): Promise<string> {
  if (messages.length === 0) {
    return '(no messages to summarize)';
  }

  // Generate summary using LLM
  const conversationText = minifyMessages(messages);

  let response;
  if (escAware) {
    // Lead agent: use ESC-aware call
    response = await escAware(
      async (abortController) => {
        return await retryChat(
          {
            model: MODEL,
            messages: [
              {
                role: 'user',
                content: `Summarize the following conversation segment. Focus on: "${description}"

Include:
1. What was discovered/accomplished
2. Key files and locations
3. Important decisions or findings
4. Any pending items

Conversation:
${conversationText}`,
              },
            ],
          },
          { signal: abortController.signal },
        );
      },
      () => null
    );

    // Check if ESC was pressed (null response from cleanup)
    if (!response) {
      return `[RECAP] Cancelled: ESC pressed during summarization. Checkpoint "${description}" remains open.`;
    }
  } else {
    // Teammate: regular LLM call (no ESC handling)
    response = await retryChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: `Summarize the following conversation segment. Focus on: "${description}"

Include:
1. What was discovered/accomplished
2. Key files and locations
3. Important decisions or findings
4. Any pending items

Conversation:
${conversationText}`,
        },
      ],
    });
  }

  const summary = response.message.content || '(no summary)';

  return `[RECAP] Completed checkpoint "${description}"

Summary:
${summary}${comment ? `\n\nLLM Comment: ${comment}` : ''}

Checkpoint closed. ${messages.length} messages compressed into summary.

Note: the checkpoint todo item was auto-created with this checkpoint's ID as its note. Use todo_update to mark it as done.`;
}

/**
 * Add checkpoint marker as user message (to be called after tool response)
 */
export function addCheckpointMarker(triologue: Triologue, id: string, description: string): void {
  triologue.user(`[CHECKPOINT ${id}: ${description}]`);
}

