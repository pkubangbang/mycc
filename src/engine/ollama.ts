/**
 * ollama.ts - Ollama provider
 *
 * Ollama-specific: client init, retryChat, reconstructResponse, retryMultipleChoice.
 * Provider-agnostic utilities are imported from ./chat-helpers.js.
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse } from 'ollama';
import { getOllamaHost, getOllamaApiKey, getOllamaModel } from '../config.js';
import { agentIO } from '../loop/agent-io.js';
import {
  collectStream,
  isTransientError,
  calculateDelay,
  sleep,
  startSpinner,
  stopSpinner,
  StreamAbortedError,
  StreamTimeoutError,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from './chat-helpers.js';

// Re-export for convenience (health-check, agent-repl, etc.)
export { getOllamaHost, getOllamaApiKey, getOllamaModel };

// Module-level constants
export const OLLAMA_HOST = getOllamaHost();
export const OLLAMA_API_KEY = getOllamaApiKey();
export const MODEL = getOllamaModel();

export const ollama = new Ollama({
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
  request: Omit<ChatRequest, 'stream'> & { stream?: false },
  config?: Partial<RetryConfig> & { signal?: AbortSignal; neglected?: boolean; noSpinner?: boolean },
): Promise<ChatResponse> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const signal = config?.signal;
  const neglected = config?.neglected ?? false;
  const noSpinner = config?.noSpinner ?? false;
  let lastError: Error | null = null;

  if (!noSpinner) {
    startSpinner(neglected ? NEGLECTED_SPINNER_TEXT : 'Thinking');
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
    stopSpinner();
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
          if (lastMessage.role === 'user') {
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
