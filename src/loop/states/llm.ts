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
import { retryChat, MODEL, stopSpinner } from '../../ollama.js';
import { buildPlanModePrompt, buildNormalModePrompt, isInPlanMode } from '../agent-prompts.js';
import { agentIO } from '../agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
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

  // Retry loop: internal backoff (via retryChat) + user-prompted retry
  while (true) {
    // Determine tools (empty in neglected mode = text-only response)
    const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope);

    try {
      // If ESC was already pressed before entering escAware, start wrap-up and return early
      if (agentIO.isNeglectedMode()) {
        ctx.core.verbose('llm', 'ESC pressed before LLM call - starting wrap-up');
        stopSpinner(); // Ensure spinner is stopped before returning to PROMPT
        startWrapUp(triologue);
        return AgentState.PROMPT;
      }

      const response = await ctx.core.escAware(
        async (abortController) => {
          // Store abort controller for potential external abort
          pass.abortController = abortController;

          return await retryChat(
            {
              model: MODEL,
              messages: triologue.getMessages(),
              tools,
              think: agentIO.isNeglectedMode() || isInPlanMode(ctx),
            },
            { signal: abortController.signal, neglected: agentIO.isNeglectedMode() },
          );
        },
        () => {
          // This runs when ESC is pressed DURING the LLM call
          // Always start wrap-up to give user a quick response
          startWrapUp(triologue);
          return null;
        }
      );

      // Check if ESC was pressed (null response from cleanup)
      if (!response) {
        ctx.core.verbose('llm', 'LLM response discarded due to ESC interruption');
        stopSpinner(); // Ensure spinner is stopped before returning to PROMPT
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
      // For transient errors that exhausted retryChat's internal retries
      // but might still be recoverable — ask the input provider
      const errorMessage = err instanceof Error ? err.message : String(err);
      const shouldRetry = await inputProvider.promptRetry(errorMessage);

      if (shouldRetry) {
        console.log(chalk.cyan('Retrying...'));
        continue;
      }

      // User declined retry — return to PROMPT instead of throwing
      // This keeps the agent alive; user can inspect state and continue
      console.log(chalk.yellow('LLM call failed. Returning to prompt.'));
      return AgentState.PROMPT;
    }
  }
}
