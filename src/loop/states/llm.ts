/**
 * llm.ts - LLM state handler
 *
 * Builds the system prompt, calls retryChat with internal retry loop,
 * handles abort and transient errors, and stores the response data
 * on PassData for downstream states.
 *
 * Crossroad feature:
 * - After LLM response, detect turning words (However, Wait, 但, etc.)
 * - If found, truncate output, generate alternative continuations, select best
 * - Discard tool calls — LLM will regenerate them after crossroad
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
import { retryChat, MODEL } from '../../engine/chat-provider.js';
import { stopSpinner } from '../../engine/chat-helpers.js';
import { buildPlanModePrompt, buildNormalModePrompt, isInPlanMode } from '../agent-prompts.js';
import { agentIO } from '../agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { loader } from '../../context/shared/loader.js';
import { handleCrossroad } from '../crossroad.js';

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
        startWrapUp(triologue, tools);
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
          startWrapUp(triologue, tools);
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
      pass.assistantReasoningContent = (assistantMessage as unknown as Record<string, unknown>).reasoning_content as string | undefined;

      // Release the LLM call's abort controller — it's no longer needed
      pass.abortController = null;

      // =====================================================================
      // Crossroad: detect turning words, generate alternative continuations
      // =====================================================================
      // Only run when tools are available — crossroad needs tool definitions
      // to preserve prompt cache during forkChat calls.
      // Wrapped in escAware so ESC during crossroad processing returns null
      // (transparent skip), using the original LLM output as-is.
      if (tools.length > 0) {
        const crossroadResult = await ctx.core.escAware(
          async (abortController) => {
            return await handleCrossroad(
              triologue.getMessages(),
              pass.assistantContent,
              pass.rawToolCalls,
              tools,
              abortController.signal,
            );
          },
          () => null,
        );
        if (crossroadResult) {
          ctx.core.verbose('llm',
            `Crossroad: truncated at "${crossroadResult.truncated.slice(0, 80)}..."`,
            `Continuation: "${crossroadResult.continuation.slice(0, 80)}..."`,
          );
          // Replace content with truncated prefix + continuation will be injected in hook.ts
          pass.assistantContent = crossroadResult.truncated;
          pass.crossroadContinuation = crossroadResult.continuation;
          // Discard original tool calls — LLM will regenerate them after crossroad
          pass.rawToolCalls = [];
        }
      }

      // Handle edge case where LLM returns empty content AND no tool calls
      if (!pass.assistantContent && pass.rawToolCalls.length === 0) {
        ctx.core.verbose('llm', 'LLM returned empty response (no content, no tool calls). Injecting synthetic brief() to prompt re-engagement.');
        if (triologue.getLastRole() !== 'tool') {
          // Inject a synthetic brief tool call so the LLM sees its own
          // "Let me see what to do next." thought in the conversation,
          // rather than a passive [CONTINUE] note. Confidence 7 means
          // slightly uncertain, nudging confusion index toward hint threshold.
          const briefCallId = Math.random().toString(36).slice(2, 10);
          triologue.agent('', [{
            id: briefCallId,
            function: {
              name: 'brief',
              arguments: { message: 'Let me see what to do next.', confidence: 7 },
            },
          }]);
          triologue.tool('brief', 'OK', briefCallId);
        }
        continue; // Re-run the while loop and call LLM again
      }

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