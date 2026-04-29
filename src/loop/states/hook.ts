/**
 * hook.ts - HOOK state handler
 *
 * Augments raw tool calls with metadata, evaluates hook conditions,
 * registers the agent response with triologue, and branches to
 * TOOL (has calls) or STOP (no calls).
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { ToolCall } from '../../types.js';
import { agentIO } from '../agent-io.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';

export async function handleHook(
  env: MachineEnv,
  turn: TurnVars,
  pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx, hookExecutor } = env;

  // Augment tool calls with metadata (file paths, LOC, destructive detection)
  const augmentedCalls = augmentToolCalls(pass.rawToolCalls);
  pass.augmentedCalls = augmentedCalls;

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

  // First round + has tool calls + has content → brief the response
  if (turn.isFirstRound && pass.assistantContent) {
    ctx.core.brief('info', 'assistant', pass.assistantContent);
  }

  // From the second round onward, mute LLM text responses
  turn.isFirstRound = false;

  return AgentState.TOOL;
}
