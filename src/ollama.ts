/**
 * ollama.ts - Ollama client initialization utility
 *
 * Centralizes Ollama client configuration for all agent files.
 */

import { Ollama } from 'ollama';
import type { ChatRequest, ChatResponse } from 'ollama';
import chalk from 'chalk';
import { isVerbose, getOllamaHost, getOllamaApiKey, getOllamaModel } from './config.js';

// Configuration (resolved via config.ts)
export const OLLAMA_HOST = getOllamaHost();
export const OLLAMA_API_KEY = getOllamaApiKey();
export const MODEL = getOllamaModel();

// Initialize Ollama client
export const ollama = new Ollama({
  host: OLLAMA_HOST,
  ...(OLLAMA_API_KEY ? { headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` } } : {}),
});

/**
 * Transient error patterns that indicate recoverable network issues
 */
const TRANSIENT_ERROR_PATTERNS = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'unexpected eof',
  'connection reset',
  'socket hang up',
  'network error',
  'fetch failed',
  'rate limit',
  'timeout',
  'timed out',
  'aborted',
  'service temporarily unavailable',
  '503',
  '500',
  '502',
  '504',
  'internal server error',
  'bad gateway',
  'gateway timeout',
];

/**
 * Check if an error is transient (recoverable with retry)
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Error types for different handling strategies
 */
export type ErrorType = 'transient' | 'auth' | 'model' | 'config' | 'fatal';

/**
 * Classify an error by type for appropriate handling
 */
export function classifyError(err: unknown): ErrorType {
  if (!(err instanceof Error)) return 'fatal';
  const msg = err.message.toLowerCase();

  // Auth errors - user action required
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'auth';
  }

  // Model errors - user action required
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) {
    return 'model';
  }

  // Config errors - context length exceeded
  if (msg.includes('context') && msg.includes('exceed')) {
    return 'config';
  }

  // Transient errors - auto-retry
  if (isTransientError(err)) return 'transient';

  return 'fatal';
}

/**
 * Retry configuration for Ollama API calls
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs: number;
  /** First token timeout in milliseconds (default: 20000 = 20 seconds) */
  firstTokenTimeoutMs?: number;
  /** Full response timeout in milliseconds (default: 120000 = 2 minutes) */
  responseTimeoutMs?: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  firstTokenTimeoutMs: 20000, // 20 seconds - time to first token
  responseTimeoutMs: 120000, // 2 minutes - full response time
};

/**
 * Generic retry with exponential backoff
 * Can be used for any async operation that may fail transiently
 * Note: This uses a simple timeout, not the two-tier timeout system used in retryChat
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig> & { timeoutMs?: number }
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    try {
      // Apply timeout if specified (uses custom timeoutMs for this generic function)
      if (config?.timeoutMs) {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Request timed out after ${config.timeoutMs}ms`)), config.timeoutMs)
          ),
        ]);
      }
      return await operation();
    } catch (err) {
      // Check if it's a transient error
      if (!isTransientError(err)) {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      const isLastAttempt = attempt > cfg.maxRetries;
      if (!isLastAttempt) {
        const delay = calculateDelay(attempt, cfg);
        console.log(`[retry] Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('All retry attempts failed');
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  // Add jitter (±25%) to prevent thundering herd
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Simple spinner for indicating API activity
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

export function startSpinner(prefix: string = 'Thinking'): void {
  if (spinnerInterval) return; // Already running

  process.stderr.write('\x1b[?25l'); // Hide cursor
  spinnerFrame = 0;
  spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    process.stderr.write(`\r${frame} ${prefix}...`);
    spinnerFrame++;
  }, 80);
}

/**
 * Spinner text for neglected mode
 */
const NEGLECTED_SPINNER_TEXT = 'Hold on';

export function stopSpinner(): void {
  if (!spinnerInterval) return;

  clearInterval(spinnerInterval);
  spinnerInterval = null;
  process.stderr.write('\r\x1b[K'); // Clear line
  process.stderr.write('\x1b[?25h'); // Show cursor
}

// ─── Stream collection (provider-agnostic) ───────────────────────────

/**
 * Thrown when a stream timeout elapses.
 * Always transient — callers should retry.
 */
class StreamTimeoutError extends Error {
  constructor(
    message: string,
    public readonly reason: 'first-token' | 'response',
  ) {
    super(message);
    this.name = 'StreamTimeoutError';
  }
}

/**
 * Thrown when the user explicitly aborts the stream (ESC/Ctrl+C).
 * Always fatal — callers must propagate immediately.
 */
class StreamAbortedError extends Error {
  constructor(cause?: unknown) {
    super('Request aborted');
    this.name = 'StreamAbortedError';
    if (cause) this.cause = cause;
  }
}

/**
 * Collect all chunks from an AsyncIterable, guarded by two-tier timeout
 * and an external abort signal.
 *
 * Provider-agnostic: works with any LLM API that exposes streamed responses
 * as an AsyncIterable. The `abort` callback kills the underlying connection
 * when a deadline fires.
 *
 * @param stream  The raw async iterable of response chunks
 * @param abort   Called to kill the transport on timeout or ESC
 * @param config  .firstTokenTimeoutMs — max ms for first chunk
 *                .responseTimeoutMs  — max ms for the entire stream
 *                .signal             — external AbortSignal (ESC)
 * @returns       All collected chunks in order
 *
 * @throws {StreamAbortedError} if the signal fires (fatal)
 * @throws {StreamTimeoutError} if a timeout elapses (transient)
 */
async function collectStream<T>(
  stream: AsyncIterable<T>,
  abort: (() => void) | undefined,
  config: {
    firstTokenTimeoutMs?: number;
    responseTimeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<T[]> {
  const { firstTokenTimeoutMs, responseTimeoutMs, signal } = config;

  let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let responseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let firstTokenReceived = false;
  let firstTokenTimeoutFired = false;
  let responseTimeoutFired = false;

  const cleanup = () => {
    if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
    if (responseTimeoutId) clearTimeout(responseTimeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  const onAbort = () => {
    abort?.();
    cleanup();
  };

  if (signal) {
    if (signal.aborted) throw new StreamAbortedError();
    signal.addEventListener('abort', onAbort, { once: true });
  }

  if (firstTokenTimeoutMs) {
    firstTokenTimeoutId = setTimeout(() => {
      if (!firstTokenReceived) {
        firstTokenTimeoutFired = true;
        abort?.();
      }
    }, firstTokenTimeoutMs);
  }

  if (responseTimeoutMs) {
    responseTimeoutId = setTimeout(() => {
      responseTimeoutFired = true;
      abort?.();
    }, responseTimeoutMs);
  }

  // Separate promise so Promise.race() rejects immediately on abort,
  // without waiting for the next stream chunk
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new StreamAbortedError()), { once: true });
      })
    : null;

  try {
    const streamPromise = (async () => {
      const chunks: T[] = [];

      for await (const chunk of stream) {
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          if (firstTokenTimeoutId) {
            clearTimeout(firstTokenTimeoutId);
            firstTokenTimeoutId = null;
          }
        }

        chunks.push(chunk);

        if (signal?.aborted) throw new StreamAbortedError();
      }

      if (firstTokenTimeoutFired) {
        throw new StreamTimeoutError(
          `Request timed out after ${firstTokenTimeoutMs}ms (waiting for first token)`,
          'first-token',
        );
      }
      if (responseTimeoutFired) {
        throw new StreamTimeoutError(
          `Response timed out after ${responseTimeoutMs}ms`,
          'response',
        );
      }

      return chunks;
    })();

    const promises: Promise<T[] | never>[] = [streamPromise];
    if (abortPromise) promises.push(abortPromise);

    return await Promise.race(promises);
  } catch (err) {
    // Always propagate aborts; don't let stream errors mask them
    if (err instanceof StreamAbortedError) throw err;
    if (signal?.aborted) throw new StreamAbortedError(err instanceof Error ? err : undefined);
    throw err;
  } finally {
    cleanup();
  }
}

// ─── Ollama-specific helpers ──────────────────────────────────────────

/**
 * Reconstruct a complete ChatResponse from streamed chunks.
 * Provider-specific (Ollama). Replace when migrating to a different LLM API.
 */
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
      // Ollama sends tool calls in a single chunk, not streamed across chunks
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

function logVerboseRequest(request: Omit<ChatRequest, 'stream'>): void {
  if (!isVerbose()) return;
  console.log(chalk.magenta('[verbose][ollama] Request:'));
  console.log(chalk.gray(`  Model: ${request.model}`));
  console.log(chalk.gray(`  Messages: ${request.messages?.length || 0}`));
  if (request.tools && request.tools.length > 0) {
    console.log(chalk.gray(`  Tools: ${request.tools.length} (${request.tools.map(t => t.function?.name || 'unknown').join(', ')})`));
  }
  if (request.format) {
    console.log(chalk.gray(`  Format: ${request.format}`));
  }
}

function logVerboseResponse(response: ChatResponse): void {
  if (!isVerbose()) return;
  console.log(chalk.magenta('[verbose][ollama] Response:'));
  const content = response.message.content || '';
  console.log(chalk.gray(`  Content (${content.length} chars): ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`));
  if (response.message.tool_calls && response.message.tool_calls.length > 0) {
    console.log(chalk.gray(`  Tool calls: ${response.message.tool_calls.length}`));
    for (const tc of response.message.tool_calls) {
      const argsPreview = JSON.stringify(tc.function.arguments).slice(0, 100);
      console.log(chalk.gray(`    - ${tc.function.name}: ${argsPreview}${argsPreview.length >= 100 ? '...' : ''}`));
    }
  }
  if (response.done_reason) {
    console.log(chalk.gray(`  Done reason: ${response.done_reason}`));
  }
}

// ─── retryChat ────────────────────────────────────────────────────────

/**
 * Chat with automatic retry on transient errors.
 *
 * Composes:
 * - ollama.chat({stream:true}) to get the raw stream
 * - collectStream<ChatResponse>() for timeout + abort protection
 * - reconstructResponse() to merge chunks into a final ChatResponse
 *
 * To migrate to a different LLM provider, swap the stream source and
 * replace reconstructResponse() with the provider's merge logic.
 * collectStream() is provider-agnostic and stays unchanged.
 */
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

  logVerboseRequest(request);

  try {
    for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
      if (signal?.aborted) throw new StreamAbortedError();

      if (attempt > 1 && isVerbose()) {
        console.log(chalk.magenta(`[verbose][ollama] Retry attempt ${attempt}/${cfg.maxRetries + 1}`));
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
        logVerboseResponse(response);
        return response;
      } catch (err) {
        // User-initiated abort — fatal, propagate immediately
        if (err instanceof StreamAbortedError) throw err;

        // StreamTimeoutError is always transient
        if (err instanceof StreamTimeoutError) {
          lastError = err;
        } else if (!isTransientError(err)) {
          throw err; // non-transient → fail fast
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        const isLastAttempt = attempt > cfg.maxRetries;
        if (!isLastAttempt) {
          const delay = calculateDelay(attempt, cfg);
          console.log(`[ollama] Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  } finally {
    stopSpinner();
  }
}
