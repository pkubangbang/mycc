/**
 * llm.ts - LLM state handler
 *
 * Builds the system prompt, calls retryChat with internal retry loop,
 * handles abort and transient errors, and stores the response data
 * on PassData for downstream states.
 *
 * Quick-return ESC behavior:
 * - When ESC is pressed during LLM call, start background wrap-up
 * - Return PROMPT immediately so user sees the prompt ASAP
 * - Wrap-up continues in background and shows as letter-box above prompt
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { ToolCall } from '../../types.js';
import { retryChat, MODEL } from '../../ollama.js';
import { buildPlanModePrompt, buildNormalModePrompt, isInPlanMode } from '../agent-prompts.js';
import { agentIO } from '../agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { isVerbose } from '../../config.js';
import { loader } from '../../context/shared/loader.js';

export async function handleLlm(
  env: MachineEnv,
  _turn: TurnVars,
  pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx, scope, inputProvider } = env;

  // Build system prompt based on mode
  const workDir = ctx.core.getWorkDir();
  const hasTeam = ctx.team.printTeam() !== 'No teammates.';
  
  let systemPrompt: string;
  if (isInPlanMode(ctx)) {
    systemPrompt = buildPlanModePrompt(workDir, hasTeam);
  } else {
    systemPrompt = buildNormalModePrompt(workDir, undefined, hasTeam);
  }
  triologue.setSystemPrompt(systemPrompt);

  if (isVerbose()) {
    agentIO.log(chalk.magenta('[verbose][llm] System prompt:'));
    agentIO.log(chalk.gray(systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? '...' : '')));
  }

  // Retry loop: internal backoff (via retryChat) + user-prompted retry
  while (true) {
    // Create abort controller for this LLM call
    const abortController = agentIO.createLlmAbortController();
    pass.abortController = abortController;

    // Determine tools (empty in neglected mode = text-only response)
    const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope);

    try {
      const response = await retryChat(
        {
          model: MODEL,
          messages: triologue.getMessages(),
          tools,
          think: agentIO.isNeglectedMode(),
        },
        { signal: abortController.signal, neglected: agentIO.isNeglectedMode() },
      );

      agentIO.clearLlmAbortController();

      // Check if ESC was pressed DURING this LLM call
      if (abortController.signal.aborted) {
        agentIO.log(chalk.yellow('[ESC] LLM response discarded due to interruption'));

        // Quick-return ESC: start background wrap-up and return PROMPT immediately
        startWrapUp(triologue);

        return AgentState.PROMPT;
      }

      // Store response data on pass for downstream states
      const assistantMessage = response.message;
      pass.rawToolCalls = assistantMessage.tool_calls
        ? [...(assistantMessage.tool_calls as ToolCall[])]
        : [];
      pass.assistantContent = assistantMessage.content || '';
      pass.abortController = null;

      return AgentState.HOOK;
    } catch (err) {
      // Always clear abort controller
      agentIO.clearLlmAbortController();

      // Abort during LLM call
      if (err instanceof Error && err.message === 'Request aborted') {
        agentIO.log(chalk.yellow('[ESC] LLM call interrupted'));

        // Quick-return ESC: start background wrap-up and return PROMPT immediately
        startWrapUp(triologue);

        return AgentState.PROMPT;
      }

      // For transient errors that exhausted retryChat's internal retries
      // but might still be recoverable — ask the input provider
      const errorMessage = err instanceof Error ? err.message : String(err);
      const shouldRetry = await inputProvider.promptRetry(errorMessage);

      if (shouldRetry) {
        console.log(chalk.cyan('Retrying...'));
        continue;
      }

      throw err;
    }
  }
}
