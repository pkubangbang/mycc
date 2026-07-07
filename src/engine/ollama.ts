/**
 * ollama.ts - Ollama provider
 *
 * Ollama-specific: client init, retryChat, reconstructResponse, retryMultipleChoice.
 * Provider-agnostic utilities are imported from ./chat-helpers.js.
 */

import chalk from 'chalk';
import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse, WebSearchResult, WebFetchResponse } from 'ollama';
import { getOllamaHost, getOllamaApiKey, getOllamaModel, getVisionModel, isVisionEnabled } from '../config.js';
import { agentIO } from '../loop/agent-io.js';
import type { HealthCheckResult } from './health-check.js';
import { probeModel } from './health-check.js';
import {
  collectStream,
  isTransientError,
  calculateDelay,
  sleep,
  startSpinner,
  stopSpinner,
  retryWithBackoff,
  StreamAbortedError,
  StreamTimeoutError,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type RetryChatRequest,
  type RetryChatConfig,
} from './chat-helpers.js';

export const MODEL = getOllamaModel();

// Private module state
const OLLAMA_HOST = getOllamaHost();
const OLLAMA_API_KEY = getOllamaApiKey();

const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});

const NEGLECTED_SPINNER_TEXT = 'Hold on';

// ─── Ollama-specific: reconstructResponse ──────────────────────────────

function reconstructResponse(chunks: ChatResponse[], model: string): ChatResponse {
  const contentParts: string[] = [];
  let toolCalls = undefined;
  let doneReason = '';
  let totalDuration = 0;
  let loadDuration = 0;
  let promptEvalCount = 0;
  let evalCount = 0;

  for (const chunk of chunks) {
    if (chunk.message?.content) {
      contentParts.push(chunk.message.content);
    }
    if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
      if (!toolCalls) toolCalls = chunk.message.tool_calls;
    }
    if (chunk.done_reason) doneReason = chunk.done_reason;
    if (chunk.total_duration) totalDuration = chunk.total_duration;
    if (chunk.load_duration) loadDuration = chunk.load_duration;
    if (chunk.prompt_eval_count) promptEvalCount = chunk.prompt_eval_count;
    if (chunk.eval_count) evalCount = chunk.eval_count;
  }

  return {
    model,
    created_at: new Date(),
    message: { role: 'assistant' as const, content: contentParts.join(''), ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    done: true,
    done_reason: doneReason,
    total_duration: totalDuration,
    load_duration: loadDuration,
    prompt_eval_count: promptEvalCount,
    prompt_eval_duration: 0,
    eval_count: evalCount,
    eval_duration: 0,
  };
}

// ─── retryChat ──────────────────────────────────────────────────────────

export async function retryChat(
  request: RetryChatRequest,
  config?: RetryChatConfig,
): Promise<ChatResponse> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const signal = config?.signal;
  const neglected = config?.neglected ?? false;
  const noSpinner = config?.noSpinner ?? false;
  let lastError: Error | null = null;

  let spinnerStarted = false;
  if (!noSpinner) {
    startSpinner(neglected ? NEGLECTED_SPINNER_TEXT : 'Thinking');
    spinnerStarted = true;
  }

  try {
    for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
      if (signal?.aborted) throw new StreamAbortedError();

      if (attempt > 1) {
        agentIO.verbose('ollama', `Retry attempt ${attempt}/${cfg.maxRetries + 1}`);
      }

      try {
        const stream = await ollama.chat({
          ...request,
          stream: true,
        } as ChatRequest & { stream: true });

        const chunks = await collectStream<ChatResponse>(
          stream,
          () => stream.abort(),
          {
            firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
            responseTimeoutMs: cfg.responseTimeoutMs,
            signal,
          },
        );

        const response = reconstructResponse(chunks, request.model);
        return response;
      } catch (err) {
        if (err instanceof StreamAbortedError) throw err;

        if (err instanceof StreamTimeoutError) {
          lastError = err;
        } else if (!isTransientError(err)) {
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        const isLastAttempt = attempt > cfg.maxRetries;
        if (!isLastAttempt) {
          const delay = calculateDelay(attempt, cfg);
          agentIO.verbose('ollama', `Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  } finally {
    if (spinnerStarted) stopSpinner();
  }
}

// ─── retryMultipleChoice ────────────────────────────────────────────────

export async function retryMultipleChoice(
  request: Omit<ChatRequest, 'stream'>,
  choices: string[],
  config?: Partial<RetryConfig> & { signal?: AbortSignal },
): Promise<string | null> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const validChoices = choices.map(c => c.toUpperCase());

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    if (config?.signal?.aborted) {
      return null;
    }

    try {
      const response = await retryChat(request, { ...config, noSpinner: true });
      const content = response.message?.content?.trim().toUpperCase() || '';

      for (const choice of validChoices) {
        if (content === choice || content.includes(choice)) {
          return choice;
        }
      }

      if (attempt <= cfg.maxRetries) {
        const delay = calculateDelay(attempt, cfg);
        if (request.messages && request.messages.length > 0) {
          const lastMessage = request.messages[request.messages.length - 1];
          if (lastMessage && lastMessage.role === 'user') {
            lastMessage.content += `\n\nYour previous response was invalid. You must respond with exactly one of: ${validChoices.join(', ')}. No other text.`;
          }
        }
        await sleep(delay);
      }
    } catch {
      if (attempt <= cfg.maxRetries) {
        const delay = calculateDelay(attempt, cfg);
        await sleep(delay);
      }
    }
  }

  return null;
}

// ─── Auxiliary (gated capabilities) ─────────────────────────────────────

/**
 * Web search via Ollama.
 */
export async function webSearch(query: string): Promise<WebSearchResult[]> {
  return retryWithBackoff(async () => {
    const response = await ollama.webSearch({ query });
    return response.results || [];
  }, { maxRetries: 2 });
}

/**
 * Web fetch via Ollama.
 */
export async function webFetch(url: string): Promise<WebFetchResponse> {
  return retryWithBackoff(async () => {
    return await ollama.webFetch({ url });
  }, { maxRetries: 2 });
}

/**
 * Image description via Ollama vision model.
 * @param image - Base64-encoded image string
 * @param prompt - Custom prompt for the vision model
 */
export async function imgDescribe(image: string, prompt?: string): Promise<string> {
  const response = await ollama.chat({
    model: getVisionModel(),
    messages: [
      {
        role: 'user',
        content: prompt || 'Describe this image in detail.',
        images: [image],
      },
    ],
  });

  return response.message?.content || 'No description returned from vision model.';
}

/**
 * Structured chat with JSON format enforcement (Ollama-specific).
 */
export async function structuredChat(
  messages: { role: string; content: string }[],
  format: object,
): Promise<ChatResponse> {
  return ollama.chat({
    model: MODEL,
    messages: messages as ChatRequest['messages'],
    format,
    options: { temperature: 0 },
  });
}

// ─── Health check ─────────────────────────────────────────────────────────

export async function healthCheck(tokenThreshold: number): Promise<HealthCheckResult> {
  try {
    await ollama.list();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Cannot connect to Ollama at ${OLLAMA_HOST}. ${msg}. Make sure Ollama is running.`,
    };
  }

  try {
    const modelInfo = await ollama.show({ model: MODEL });

    startSpinner('Powered by Ollama. Initializing');
    const startTime = Date.now();

    // Pass model_info to probeModel so the LLM can parse it for context_length.
    // Keys are architecture-dependent (e.g. glm5.context_length, qwen3.context_length),
    // so the LLM is best placed to identify the right key. Fails fast if extraction fails.
    const { contextLength, motd } = await probeModel(
      retryChat,
      MODEL,
      modelInfo.model_info as unknown as Record<string, unknown> | undefined,
    );

    stopSpinner();
    const elapsed = Date.now() - startTime;
    console.log(`[ollama] Health check passed (${elapsed}ms)`);
    console.log(chalk.cyan(`✨ ${motd}`));

    const maxThreshold = Math.floor(contextLength * 0.8);
    if (tokenThreshold > maxThreshold) {
      return {
        ok: false,
        error: `TOKEN_THRESHOLD (${tokenThreshold}) exceeds 80% of model context length (${contextLength}). Reduce TOKEN_THRESHOLD to ${maxThreshold} or less.`,
      };
    }

    return {
      ok: true,
      warnings: isVisionEnabled()
        ? undefined
        : [
            'OLLAMA_VISION_MODEL is not set. Vision features (screen/read_picture tools) are disabled.',
            'Set it to a vision model (e.g., OLLAMA_VISION_MODEL=gemma4:31b-cloud) or "none" to dismiss this warning.',
          ],
      modelInfo: {
        name: MODEL,
        contextLength,
        family: modelInfo.details?.family,
        parameterSize: modelInfo.details?.parameter_size,
      },
    };
  } catch (err) {
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Model '${MODEL}' not found or unavailable. ${msg}. Run 'ollama list' to see available models.`,
    };
  }
}
