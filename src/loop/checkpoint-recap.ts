/**
 * checkpoint-recap.ts - Shared checkpoint and recap logic
 *
 * Used by both lead agent (hook.ts) and teammate agents (teammate-worker.ts).
 * These are meta-tools that need triologue access for message management.
 */

import chalk from 'chalk';
import type { Message } from '../types.js';
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
 * Todo module interface
 */
interface TodoModule {
  patchTodoList(items: Array<{ name: string; note?: string; done: boolean }>): void;
  printTodoList(): string;
}

/**
 * Context interface for checkpoint/recap handlers
 */
export interface CheckpointContext {
  core: CoreModule;
  todo: TodoModule;
  triologue: Triologue;
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
 * Result from recap operation
 */
export interface RecapResult {
  success: boolean;
  result: string;
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

  // Get context length at checkpoint creation
  const tokenCount = triologue.getTokenCount();
  const tokenThreshold = triologue.getTokenThreshold();
  const usagePercent = Math.round((tokenCount / tokenThreshold) * 100);

  // Add todo item
  ctx.todo.patchTodoList([{
    name: `Checkpoint: ${description}`,
    note: `ID: ${id}`,
    done: false,
  }]);

  // Brief the user (simple, colorized)
  const coloredId = chalk.cyan.bold(id);
  const coloredTokens = chalk.yellow(`${tokenCount.toLocaleString()}`);
  const coloredThreshold = chalk.gray(`${tokenThreshold.toLocaleString()}`);
  ctx.core.brief('info', 'checkpoint',
    `${coloredId}: ${description} (${coloredTokens}/${coloredThreshold} tokens)`
  );

  return {
    success: true,
    result: `Checkpoint created: ${id}

Description: ${description}
Context: ${tokenCount} / ${tokenThreshold} tokens (${usagePercent}%)

Next steps:
1. Perform your subtask (read files, run commands, etc.)
2. When done, call recap({ checkpoint_id: "${id}" }) to compress messages into a summary
3. The todo item will be marked as done automatically

Current todo list:
${ctx.todo.printTodoList()}`,
    id,
    description,
  };
}

/**
 * Handle recap meta-tool
 * Summarizes messages from checkpoint to end and replaces them with summary.
 * Uses escAware for ESC-interruptible LLM call (for lead agent only).
 * For teammate, we use a simpler approach without ESC handling.
 *
 * Note: Recap is a meta-tool that directly manipulates conversation history.
 * Unlike regular tools, it does NOT add tool call/result messages to triologue.
 * Instead, it replaces messages from checkpoint onwards with a summary pair.
 *
 * @param args - Tool arguments (checkpoint_id, abandon)
 * @param ctx - Checkpoint context with triologue access
 * @param escAware - Optional ESC-aware wrapper for lead agent
 */
export async function handleRecap(
  args: Record<string, unknown>,
  ctx: CheckpointContext,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<RecapResult> {
  const triologue = ctx.triologue;
  const checkpointId = args.checkpoint_id as string;
  const abandon = args.abandon === true;
  const comment = typeof args.comment === 'string' && args.comment.trim() ? args.comment.trim() : undefined;

  if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim() === '') {
    return { success: false, result: 'Error: checkpoint_id is required and must be a non-empty string.' };
  }

  // Find checkpoint by ID
  const checkpoint = triologue.findCheckpointById(checkpointId);
  if (!checkpoint) {
    // List available checkpoints for helpful error
    const allCheckpoints = triologue.findAllCheckpoints();
    if (allCheckpoints.length === 0) {
      return { success: false, result: 'Error: No checkpoint found.' };
    }
    const availableList = allCheckpoints.map(cp => `[${cp.id}: ${cp.description}]`).join(', ');
    return { success: false, result: `Error: Checkpoint "${checkpointId}" not found. Available: ${availableList}` };
  }

  // Get messages from checkpoint to end
  const messages = triologue.getMessagesFrom(checkpoint.index);

  // Get token count BEFORE recap
  const tokensBefore = triologue.getTokenCount();

  // Handle abandon mode: discard messages without summarizing
  if (abandon) {
    // Create abandon messages (brief marker, no summary)
    const commentSuffix = comment ? `\n\n**Comment:** ${comment}` : '';
    const userMessage: Message = {
      role: 'user',
      content: `[RECAP] Abandoned checkpoint "${checkpoint.description}"${commentSuffix}`,
    };
    const assistantMessage: Message = {
      role: 'assistant',
      content: 'Understood. Checkpoint abandoned, messages discarded.',
    };

    const abandonResult = `[RECAP] Abandoned checkpoint "${checkpoint.description}"

${messages.length} messages discarded. Checkpoint closed.${comment ? `\n\nComment: ${comment}` : ''}`;

    // Replace messages from checkpoint onwards with abandon marker
    triologue.recapMessages(checkpoint.index, userMessage, assistantMessage);

    // Get token count AFTER recap
    const tokensAfter = triologue.getTokenCount();

    // Mark todo as done
    ctx.todo.patchTodoList([{
      name: `Checkpoint: ${checkpoint.description}`,
      done: true,
    }]);

    // Brief the user
    const coloredBefore = chalk.yellow(tokensBefore.toLocaleString());
    const coloredAfter = chalk.green(tokensAfter.toLocaleString());
    ctx.core.brief('info', 'recap',
      `(${coloredBefore} → ${coloredAfter} tokens)`,
      `Abandoned: ${checkpoint.description}${comment ? ` — ${comment}` : ''}`
    );

    return {
      success: true,
      result: abandonResult,
    };
  }

  // Normal mode: summarize messages
  if (messages.length === 0) {
    return { success: false, result: 'Error: No messages to summarize.' };
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
                content: `Summarize the following conversation segment. Focus on: "${checkpoint.description}"

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
      return {
        success: false,
        result: `[RECAP] Cancelled: ESC pressed during summarization. Checkpoint "${checkpoint.description}" remains open.`
      };
    }
  } else {
    // Teammate: regular LLM call (no ESC handling)
    response = await retryChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: `Summarize the following conversation segment. Focus on: "${checkpoint.description}"

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

  // Create recap messages (user + assistant pair, matching autoCompact pattern)
  const commentSuffix = comment ? `\n\n**LLM Comment:** ${comment}` : '';
  const userMessage: Message = {
    role: 'user',
    content: `[RECAP] Completed checkpoint "${checkpoint.description}":\n${summary}${commentSuffix}`,
  };
  const assistantMessage: Message = {
    role: 'assistant',
    content: 'Understood. I have the checkpoint summary. Continuing.',
  };

  const recapResult = `[RECAP] Completed checkpoint "${checkpoint.description}"

Summary:
${summary}${comment ? `\n\nLLM Comment: ${comment}` : ''}

Checkpoint closed. ${messages.length} messages compressed into summary.`;

  // Replace messages from checkpoint onwards with summary
  triologue.recapMessages(checkpoint.index, userMessage, assistantMessage);

  // Get token count AFTER recap
  const tokensAfter = triologue.getTokenCount();

  // Mark todo as done
  ctx.todo.patchTodoList([{
    name: `Checkpoint: ${checkpoint.description}`,
    done: true,
  }]);

  // Brief the user (simple, colorized)
  const coloredBefore = chalk.yellow(tokensBefore.toLocaleString());
  const coloredAfter = chalk.green(tokensAfter.toLocaleString());
  ctx.core.brief('info', 'recap',
    `(${coloredBefore} → ${coloredAfter} tokens)`,
    `${checkpoint.description}${comment ? ` — ${comment}` : ''}`
  );

  return {
    success: true,
    result: recapResult,
  };
}

/**
 * Add checkpoint marker as user message (to be called after tool response)
 */
export function addCheckpointMarker(triologue: Triologue, id: string, description: string): void {
  triologue.user(`[CHECKPOINT ${id}: ${description}]`);
}

/**
 * Add continuation prompt after recap (teammate version)
 */
export function addContinuationPrompt(triologue: Triologue): void {
  triologue.user('Continue with your task.');
}