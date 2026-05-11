/**
 * hook.ts - HOOK state handler
 *
 * Augments raw tool calls with metadata, evaluates hook conditions,
 * registers the agent response with triologue, and branches to
 * TOOL (has calls) or STOP (no calls).
 *
 * META-TOOLS: checkpoint and recap are handled here (not as regular tools)
 * because they need access to triologue which is not in AgentContext.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { ToolCall, Message } from '../../types.js';
import type { AugmentedToolCall } from '../../hook/hook-executor.js';
import { agentIO } from '../agent-io.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { Triologue } from '../triologue.js';
import { retryChat, MODEL } from '../../ollama.js';
import { minifyMessages } from '../../utils/llm-chat-minifier.js';

/**
 * Validate that checkpoint is called alone (no other tools in same turn)
 */
function validateCheckpointIsolation(calls: AugmentedToolCall[]): { valid: boolean; message?: string } {
  const hasCheckpoint = calls.some(c => c.function.name === 'checkpoint');
  if (!hasCheckpoint) {
    return { valid: true };
  }
  
  if (calls.length > 1) {
    return {
      valid: false,
      message: 'Checkpoint must be called alone. Other tools cannot be used in the same turn.',
    };
  }
  
  return { valid: true };
}

/**
 * Handle checkpoint meta-tool
 * Creates a checkpoint marker in the message history
 * NOTE: Does NOT add the checkpoint marker - that's done by the caller after tool response
 */
function handleCheckpoint(
  triologue: Triologue,
  args: Record<string, unknown>,
  ctx: MachineEnv['ctx']
): { result: string; id: string; description: string } {
  const description = args.description as string;

  if (!description || typeof description !== 'string' || description.trim() === '') {
    return { result: 'Error: description is required and must be a non-empty string.', id: '', description: '' };
  }

  // Check for existing open checkpoint
  const existingCheckpoint = triologue.findOpenCheckpoint();
  if (existingCheckpoint) {
    return { result: `Error: Checkpoint already exists: ${existingCheckpoint.id} "${existingCheckpoint.description}". Call recap first to close it, or remove it if abandoned.`, id: '', description: '' };
  }

  // Generate checkpoint ID
  const id = Triologue.generateCheckpointId();

  // Add todo item
  ctx.todo.patchTodoList([{
    name: `Checkpoint: ${description}`,
    note: `ID: ${id}`,
    done: false,
  }]);

  // Brief the user
  ctx.core.brief('info', 'checkpoint', `Created checkpoint ${id}: "${description}"`);

  return {
    result: `Checkpoint created: ${id}

Description: ${description}

Next steps:
1. Perform your subtask (read files, run commands, etc.)
2. When done, call recap({ checkpoint_id: "${id}" }) to compress messages into a summary
3. The todo item will be marked as done automatically`,
    id,
    description,
  };
}

/**
 * Handle recap meta-tool
 * Summarizes messages from checkpoint to end and replaces them with summary
 * Uses escAware for ESC-interruptible LLM call
 */
async function handleRecap(
  triologue: Triologue,
  args: Record<string, unknown>,
  ctx: MachineEnv['ctx']
): Promise<string> {
  const checkpointId = args.checkpoint_id as string;

  if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim() === '') {
    return 'Error: checkpoint_id is required and must be a non-empty string.';
  }

  // Find checkpoint by ID
  const checkpoint = triologue.findCheckpointById(checkpointId);
  if (!checkpoint) {
    // List available checkpoints for helpful error
    const allCheckpoints = triologue.findAllCheckpoints();
    if (allCheckpoints.length === 0) {
      return 'Error: No checkpoint found.';
    }
    const availableList = allCheckpoints.map(cp => `[${cp.id}: ${cp.description}]`).join(', ');
    return `Error: Checkpoint "${checkpointId}" not found. Available: ${availableList}`;
  }

  // Get messages from checkpoint to end
  const messages = triologue.getMessagesFrom(checkpoint.index);

  if (messages.length === 0) {
    return 'Error: No messages to summarize.';
  }

  // Generate summary using LLM (with ESC awareness)
  const conversationText = minifyMessages(messages);

  const response = await ctx.core.escAware(
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
    () => {
      // Cleanup when ESC is pressed - return null to indicate interruption
      return null;
    }
  );

  // Check if ESC was pressed (null response from cleanup)
  if (!response) {
    return `[RECAP] Cancelled: ESC pressed during summarization. Checkpoint "${checkpoint.description}" remains open.`;
  }

  const summary = response.message.content || '(no summary)';

  // Create recap messages
  const userMessage: Message = {
    role: 'user',
    content: `[RECAP] Completed checkpoint "${checkpoint.description}":\n${summary}`,
  };
  const assistantMessage: Message = {
    role: 'assistant',
    content: 'Understood. I have the checkpoint summary. Continuing.',
  };

  // Replace messages from checkpoint onwards with summary
  triologue.recapMessages(checkpoint.index, userMessage, assistantMessage);

  // Mark todo as done
  ctx.todo.patchTodoList([{
    name: `Checkpoint: ${checkpoint.description}`,
    done: true,
  }]);

  // Brief the user
  ctx.core.brief('info', 'recap', `Completed checkpoint ${checkpointId}: "${checkpoint.description}" (${messages.length} messages → summary)`);

  return `[RECAP] Completed checkpoint "${checkpoint.description}"

Summary:
${summary}

Checkpoint closed. ${messages.length} messages compressed into summary.`;
}

export async function handleHook(
  env: MachineEnv,
  turn: TurnVars,
  pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx, hookExecutor } = env;

  // Augment tool calls with metadata (file paths, LOC, destructive detection)
  const augmentedCalls = augmentToolCalls(pass.rawToolCalls);
  pass.augmentedCalls = augmentedCalls;

  // Validate checkpoint isolation (must be called alone)
  const checkpointValidation = validateCheckpointIsolation(augmentedCalls);
  if (!checkpointValidation.valid) {
    // Block all calls with the error message
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined);
    for (const call of augmentedCalls) {
      triologue.tool(call.function.name, checkpointValidation.message!, call.id);
    }
    
    agentIO.log(chalk.yellow(`[checkpoint] blocked: ${checkpointValidation.message}`));
    return AgentState.STOP;
  }

  // Handle meta-tools (checkpoint and recap) - they need triologue access
  const checkpointCall = augmentedCalls.find(c => c.function.name === 'checkpoint');
  const recapCall = augmentedCalls.find(c => c.function.name === 'recap');

  if (checkpointCall) {
    // Register the tool call
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined);

    // Execute checkpoint (returns id and description for marker)
    const { result, id, description } = handleCheckpoint(triologue, checkpointCall.function.arguments as Record<string, unknown>, ctx);

    // Add tool response FIRST (maintains proper role sequence: assistant → tool)
    triologue.tool('checkpoint', result, checkpointCall.id);

    // THEN add checkpoint marker as user message for next turn
    if (id) {
      triologue.user(`[CHECKPOINT ${id}: ${description}]`);
    }

    if (pass.assistantContent) {
      ctx.core.brief('info', 'assistant', pass.assistantContent);
    }

    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  if (recapCall) {
    // For recap: DON'T register agent message first since recapMessages will replace it
    // Instead, let handleRecap manage the entire message replacement

    // Show assistant text content if any
    if (pass.assistantContent) {
      ctx.core.brief('info', 'assistant', pass.assistantContent);
    }

    // Execute recap (async) - it handles message replacement internally
    const result = await handleRecap(triologue, recapCall.function.arguments as Record<string, unknown>, ctx);

    // Brief the recap result to user
    ctx.core.brief('info', 'recap', result.split('\n')[0]); // First line of result

    // Add continuation prompt since last message is assistant acknowledgment
    triologue.user('Continue with your task.');

    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // Process hooks (block/replace/inject/message)
  const hookResult = await hookExecutor.processToolCalls(
    augmentedCalls,
    ctx,
    ctx.skill.getSkill.bind(ctx.skill),
  );
  pass.hookResult = hookResult;

  // Register agent response with triologue (using manipulated tool calls)
  const finalToolCalls =
    hookResult.calls.length > 0
      ? hookResult.calls.map((c) => ({ id: c.id, function: c.function }))
      : undefined;
  triologue.agent(
    pass.assistantContent,
    finalToolCalls as ToolCall[] | undefined,
  );

  // Register blocked calls as rejections in triologue
  if (hookResult.blockedCalls.size > 0) {
    for (const [callId, blockMessage] of hookResult.blockedCalls) {
      const name = hookResult.calls.find((c) => c.id === callId)?.function.name ?? 'unknown';
      triologue.tool(name, blockMessage, callId);
      agentIO.log(chalk.yellow(`[hook] blocked: ${blockMessage}`));
    }
  }

  // No tool calls = all blocked or LLM produced none → stop
  if (hookResult.calls.length === 0) {
    return AgentState.STOP;
  }

  if (pass.assistantContent) {
    ctx.core.brief('info', 'assistant', pass.assistantContent);
  }

  // From the second round onward, mute LLM text responses
  turn.isFirstRound = false;

  return AgentState.TOOL;
}
