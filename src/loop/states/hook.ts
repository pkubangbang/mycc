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
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { agentIO } from '../agent-io.js';
import { 
  validateCheckpointIsolation, 
  handleCheckpoint, 
  handleRecap,
  addCheckpointMarker,
  addContinuationPrompt,
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

    // Execute checkpoint using shared handler
    const checkpointCtx = createCheckpointContext(env);
    const result = handleCheckpoint(
      checkpointCall.function.arguments as Record<string, unknown>,
      checkpointCtx
    );

    // Add tool response
    triologue.tool('checkpoint', result.result, checkpointCall.id);

    // Add checkpoint marker as user message if successful
    if (result.success && result.id) {
      addCheckpointMarker(triologue, result.id, result.description);
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

    // Execute recap using shared handler (with ESC awareness for lead agent)
    const checkpointCtx = createCheckpointContext(env);
    const escAware = <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T): Promise<T> => {
      return ctx.core.escAware(fn, cleanup);
    };
    const result = await handleRecap(
      recapCall.function.arguments as Record<string, unknown>,
      checkpointCtx,
      escAware
    );

    // Brief the recap result to user
    ctx.core.brief('info', 'recap', result.result.split('\n')[0]); // First line of result

    // Add continuation prompt since last message is assistant acknowledgment
    addContinuationPrompt(triologue);

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

  // Confusion scoring: +1 per assistant turn (agent spinning without progress)
  // This is the primary driver that ensures hints trigger even during pure exploration.
  ctx.core.increaseConfusionIndex(1);

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