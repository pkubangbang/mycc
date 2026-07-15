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
import { handleCrossroad, generateAndSelect, collectTrainingData } from '../crossroad.js';
import { getCrossroadEncoder } from '../crossroad-encoder.js';
import { StreamingCrossroadDetector } from '../streaming-crossroad-detector.js';

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
        agentIO.setNeglectedMode(false);
        return AgentState.PROMPT;
      }

      const response = await ctx.core.escAware(
        async (abortController) => {
          // Store abort controller for potential external abort
          pass.abortController = abortController;

          // Create streaming crossroad detector (encoder may be null → regex fallback)
          //
          // Fallback contract: when the ONNX encoder is unavailable (null) —
          // because the model isn't installed, onnxruntime-node is missing,
          // or the model failed to load — the StreamingCrossroadDetector
          // returns { detected: false } unconditionally (checkInterval=Infinity
          // skips all inference). This causes encoderHandledCrossroad (below)
          // to stay false, so the regex-based detectTurningWord path runs as
          // the fallback. The same fallthrough happens when the encoder DOES
          // detect a turn but generateAndSelect() fails to produce a
          // continuation: content is restored to the full original and the
          // regex path gets a chance to re-detect. So the regex detector is
          // always the safety net beneath the encoder.
          const encoder = await getCrossroadEncoder();
          if (!encoder) {
            ctx.core.verbose('llm',
              'Crossroad encoder unavailable — using regex fallback (detectTurningWord)');
          }
          const detector = new StreamingCrossroadDetector(encoder, { signal: abortController.signal });

          const chatResponse = await retryChat(
            {
              model: MODEL,
              messages: triologue.getMessages(),
              tools,
              think: agentIO.isNeglectedMode() || isInPlanMode(ctx),
            },
            {
              signal: abortController.signal,
              neglected: agentIO.isNeglectedMode(),
              onChunk: (chunk) => {
                // Chunk shape differs by provider: Ollama uses
                // chunk.message?.content, DeepSeek uses
                // chunk.choices?.[0]?.delta?.content. Access both safely.
                const content =
                  (chunk as { message?: { content?: string } }).message?.content ||
                  (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ||
                  '';
                if (content) detector.onChunk(content);
              },
            },
          );

          // After stream completes, check if the encoder detected a turn
          const streamResult = await detector.finalize();
          if (streamResult.detected) {
            ctx.core.verbose('llm',
              `Streaming crossroad encoder detected turn at index ${streamResult.turnIndex}`);
            // Truncate at the detected turn index
            pass.assistantContent = streamResult.fullText.slice(0, streamResult.turnIndex).trim();
            // Collect training data
            collectTrainingData(streamResult.fullText, streamResult.turnIndex, 'encoder');
            // Generate continuation via the shared generation+selection flow
            const continuation = await generateAndSelect(
              triologue.getMessages(),
              tools,
              pass.assistantContent,
              abortController.signal,
            );
            if (continuation) {
              pass.crossroadContinuation = continuation;
              // Discard original tool calls — LLM will regenerate them after crossroad
              pass.rawToolCalls = [];
            } else {
              // Generation failed — restore original content, fall through to regex
              pass.assistantContent = chatResponse.message?.content || '';
            }
          }

          return chatResponse;
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
        agentIO.setNeglectedMode(false);
        return AgentState.PROMPT;
      }

      // Release the LLM call's abort controller — it's no longer needed
      pass.abortController = null;

      // Check if the streaming encoder already handled the crossroad
      // (pass.crossroadContinuation set inside escAware). If so, skip the
      // regex path — the encoder is an addition on top, and when it detects,
      // its result takes precedence.
      const encoderHandledCrossroad = !!pass.crossroadContinuation;

      if (!encoderHandledCrossroad) {
        // Store response data on pass for downstream states
        const assistantMessage = response.message;
        pass.rawToolCalls = assistantMessage.tool_calls
          ? [...(assistantMessage.tool_calls as ToolCall[])]
          : [];
        pass.assistantContent = assistantMessage.content || '';
        pass.assistantReasoningContent = (assistantMessage as unknown as Record<string, unknown>).reasoning_content as string | undefined;

        // =====================================================================
        // Crossroad: regex fallback — detect turning words, generate continuations
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
          // ESC pressed during crossroad processing - return to PROMPT immediately
          if (agentIO.isNeglectedMode()) {
            stopSpinner();
            return AgentState.PROMPT;
          }
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

            // Consecutive crossroad = LLM stuck hesitating → count towards hint round
            if (env.crossroadOccurred) {
              ctx.core.increaseConfusionIndex(2);
            }
            env.crossroadOccurred = true;
          } else {
            // No crossroad this pass — reset the consecutive flag
            env.crossroadOccurred = false;
          }
        } else {
          // No tools available (e.g. neglected mode) — reset the consecutive flag
          env.crossroadOccurred = false;
        }
      } else {
        // Encoder detected a turn — set reasoning content from response
        const assistantMessage = response.message;
        pass.assistantReasoningContent = (assistantMessage as unknown as Record<string, unknown>).reasoning_content as string | undefined;

        // Consecutive crossroad = LLM stuck hesitating → count towards hint round
        if (env.crossroadOccurred) {
          ctx.core.increaseConfusionIndex(2);
        }
        env.crossroadOccurred = true;
      }

      // Handle edge case where LLM returns empty content AND no tool calls
      if (!pass.assistantContent && pass.rawToolCalls.length === 0) {
        ctx.core.verbose('llm', 'LLM returned empty response (no content, no tool calls). Injecting synthetic brief() to prompt re-engagement.');
        if (triologue.getLastRole() !== 'tool') {
          // Inject a synthetic brief tool call so the LLM sees its own
          // "Let me see what to do next." thought in the conversation,
          // rather than a passive [REMINDER] note. Confidence 7 means
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