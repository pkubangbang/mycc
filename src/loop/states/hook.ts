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
import type { ToolCall } from '../../types.js';
import type { AugmentedToolCall } from '../../hook/hook-executor.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { agentIO } from '../agent-io.js';
import {
  validateCheckpointIsolation,
  handleCheckpoint,
  handleRecap,
  type CheckpointContext
} from '../checkpoint-recap.js';

/**
 * Create checkpoint context from machine environment
 */
function createCheckpointContext(env: MachineEnv): CheckpointContext {
  return {
    core: env.ctx.core,
    todo: env.ctx.todo,
    triologue: env.triologue,
  };
}

/**
 * Handle a checkpoint tool call.
 * Creates a checkpoint marker, registers the tool response with triologue,
 * and returns to COLLECT for the next round.
 */
async function handleCheckpointCall(
  call: AugmentedToolCall,
  env: MachineEnv,
  pass: PassData,
  turn: TurnVars,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  // Execute checkpoint using shared handler
  const checkpointCtx = createCheckpointContext(env);
  const result = handleCheckpoint(
    call.function.arguments as Record<string, unknown>,
    checkpointCtx,
  );

  // Register the assistant message with tool calls
  triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);

  // Add tool response (checkpoint info is in the tool result — no note needed)
  triologue.tool('checkpoint', result.result, call.id);

  if (pass.assistantContent) {
    ctx.core.brief('info', 'assistant', pass.assistantContent);
  }

  turn.isFirstRound = false;
  return AgentState.COLLECT;
}

/**
 * Handle a recap tool call.
 * Finds the checkpoint, generates a summary (or abandons), compresses
 * the triologue, and returns to COLLECT for the next round.
 */
async function handleRecapCall(
  call: AugmentedToolCall,
  env: MachineEnv,
  pass: PassData,
  turn: TurnVars,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  // Show assistant text content if any
  if (pass.assistantContent) {
    ctx.core.brief('info', 'assistant', pass.assistantContent);
  }

  // Validate and extract checkpoint + messages
  const recapArgs = call.function.arguments as Record<string, unknown>;
  const checkpointId = recapArgs.checkpoint_id as string;
  const abandon = recapArgs.abandon === true;
  const comment = typeof recapArgs.comment === 'string' && recapArgs.comment.trim()
    ? recapArgs.comment.trim()
    : undefined;

  if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim() === '') {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    triologue.tool('recap', 'Error: checkpoint_id is required and must be a non-empty string.', call.id);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  const checkpoint = triologue.findCheckpointById(checkpointId);
  if (!checkpoint) {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    const allCheckpoints = triologue.findAllCheckpoints();
    const msg = allCheckpoints.length === 0
      ? 'Error: No checkpoint found.'
      : `Error: Checkpoint "${checkpointId}" not found. Available: ${allCheckpoints.map(cp => `[${cp.id}: ${cp.description}]`).join(', ')}`;
    triologue.tool('recap', msg, call.id);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  const messages = triologue.getMessagesFrom(checkpoint.index);
  const tokensBefore = triologue.getTokenCount();

  if (abandon) {
    // Preserve the last user query from the recapped section before truncating,
    // so follow-up queries after the checkpoint are not lost.
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    // Abandon: discard messages, append ?recap + !recap (abandon marker)
    triologue.recapMessages(checkpoint.index);
    if (lastUserMsg) {
      triologue._injectBypass(lastUserMsg);
    }
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    const abandonResult = `[RECAP] Abandoned checkpoint "${checkpoint.description}"\n\n${messages.length} messages discarded. Checkpoint closed.${comment ? `\n\nComment: ${comment}` : ''}\n\nNote: the checkpoint todo item was auto-created with this checkpoint's ID as its note. Use todo_update to mark it as done.`;
    triologue.tool('recap', abandonResult, call.id);

    const tokensAfter = triologue.getTokenCount();
    const coloredBefore = chalk.yellow(tokensBefore.toLocaleString());
    const coloredAfter = chalk.green(tokensAfter.toLocaleString());
    ctx.core.brief('info', 'recap',
      `(${coloredBefore} → ${coloredAfter} tokens)`,
      `Abandoned: ${checkpoint.description}${comment ? ` — ${comment}` : ''}`
    );

    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // Normal: generate summary, then slice + append ?recap + !recap
  const escAware = <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T): Promise<T> => {
    return ctx.core.escAware(fn, cleanup);
  };
  const summary = await handleRecap(messages, checkpoint.description, escAware, comment);

  // Check for ESC cancellation (summary starts with cancellation marker)
  if (summary.startsWith('[RECAP] Cancelled:')) {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    triologue.tool('recap', summary, call.id);
    ctx.core.brief('warn', 'recap', summary);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // Preserve the last user query from the recapped section before truncating,
  // so follow-up queries after the checkpoint are not lost.
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  triologue.recapMessages(checkpoint.index);
  if (lastUserMsg) {
    triologue._injectBypass(lastUserMsg);
  }
  triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
  triologue.tool('recap', summary, call.id);

  const tokensAfter = triologue.getTokenCount();
  const coloredBefore = chalk.yellow(tokensBefore.toLocaleString());
  const coloredAfter = chalk.green(tokensAfter.toLocaleString());
  ctx.core.brief('info', 'recap',
    `(${coloredBefore} → ${coloredAfter} tokens)`,
    `${checkpoint.description}${comment ? ` — ${comment}` : ''}`
  );

  turn.isFirstRound = false;
  return AgentState.COLLECT;
}

export async function handleHook(
  env: MachineEnv,
  turn: TurnVars,
  pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx, hookExecutor } = env;

  try {
    // 1. Augment tool calls with metadata (file paths, LOC, destructive detection)
    const augmentedCalls = augmentToolCalls(pass.rawToolCalls);
    pass.augmentedCalls = augmentedCalls;

    // 2. Validate checkpoint isolation (must be called alone)
    const checkpointValidation = validateCheckpointIsolation(augmentedCalls);
    if (!checkpointValidation.valid) {
      // Block all calls with the error message
      triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
      for (const call of augmentedCalls) {
        triologue.tool(call.function.name, checkpointValidation.message!, call.id);
      }

      agentIO.log(chalk.yellow(`[checkpoint] blocked: ${checkpointValidation.message}`));
      return AgentState.STOP;
    }

    // 3. Process hooks (block/replace/inject/message) — moved before meta-tools
    //    so hooks can also fire on checkpoint/recap calls.
    const hookResult = await hookExecutor.processToolCalls(
      augmentedCalls,
      ctx,
      ctx.skill.getSkill.bind(ctx.skill),
    );
    pass.hookResult = hookResult;

    // 3.5. Handle compact request (highest priority — short-circuits all processing)
    if (hookResult.compactRequested) {
      ctx.core.brief('info', 'compact', 'Compacting context due to intent language confusion...');
      await triologue.compact();

      // Reset stat counts after hook-requested compaction — old context is
      // now summarized and accumulated confusion/sequence events are stale.
      env.ctx.core.resetConfusionIndex();
      env.sequence.clear();

      return AgentState.COLLECT;
    }

    // 4. Dispatch meta-tools (checkpoint and recap) from hook result
    //    Guard against blocked meta-calls so the agent sees the rejection.
    const checkpointCall = hookResult.calls.find(c => c.function.name === 'checkpoint');
    if (checkpointCall && !hookResult.blockedCalls.has(checkpointCall.id)) {
      return handleCheckpointCall(checkpointCall, env, pass, turn);
    }

    const recapCall = hookResult.calls.find(c => c.function.name === 'recap');
    if (recapCall && !hookResult.blockedCalls.has(recapCall.id)) {
      return handleRecapCall(recapCall, env, pass, turn);
    }

    // 5. Register agent response with triologue (using manipulated tool calls)
    const finalToolCalls =
      hookResult.calls.length > 0
        ? hookResult.calls.map((c) => ({ id: c.id, function: c.function }))
        : undefined;
    triologue.agent(
      pass.assistantContent,
      finalToolCalls as ToolCall[] | undefined,
      pass.assistantReasoningContent,
    );

    // Confusion scoring: +1 per assistant turn (agent spinning without progress)
    // In plan mode, the agent explores by reading files — tool calls are sparse,
    // so this +1 is the primary driver that ensures hints trigger.
    // In normal mode, tool calls are frequent enough to drive the hint on their own.
    if (ctx.core.getMode() === 'plan') {
      ctx.core.increaseConfusionIndex(1);
    }

    // Log blocked calls (tool responses are registered in tool.ts)
    if (hookResult.blockedCalls.size > 0) {
      for (const [callId, blockMessage] of hookResult.blockedCalls) {
        const name = hookResult.calls.find((c) => c.id === callId)?.function.name ?? 'unknown';
        agentIO.log(chalk.yellow(`[hook] blocked ${name}:\n${blockMessage}`));
      }
    }

    // No tool calls = all blocked or LLM produced none
    if (hookResult.calls.length === 0) {
      // Inject deferred hook messages so the LLM can respond to them
      // (e.g., lint-after-edit, test-after-edit block messages)
      if (hookResult.deferredMessages.length > 0) {
        triologue.note('REMINDER', hookResult.deferredMessages.join('\n\n---\n\n'));
        return AgentState.COLLECT;
      }
      return AgentState.STOP;
    }

    if (pass.assistantContent) {
      ctx.core.brief('info', 'assistant', pass.assistantContent);
    }

    // From the second round onward, mute LLM text responses
    turn.isFirstRound = false;

    return AgentState.TOOL;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'hook', `HOOK state error: ${errorMessage}`);
    return AgentState.PROMPT;
  }
}