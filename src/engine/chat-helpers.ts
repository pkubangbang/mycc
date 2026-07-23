/**
 * chat-helpers.ts - Provider-agnostic utilities for LLM chat
 *
 * Extracted from ollama.ts. All functions here work with any LLM provider.
 * Provider-specific code lives in ollama.ts / deepseek.ts.
 */

import type { ChatRequest } from 'ollama';
import { agentIO } from '../loop/agent-io.js';

// ============================================================================
// Error Helpers
// ============================================================================

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
  'overloaded',
  'overload',
  // HTTP/2 GOAWAY errors — recoverable connection teardown
  'goaway',
  'http2',
  'nghttp2',
  'protocol error',
  'stream error',
  'session',
  'socket is not writable',
  'premature close',
  'http2 session',
  'frame',
  'destroy',
  // Windows TCP errors (wsarecv) — the socket layer surfaces these when a
  // remote host hangs during connect/read (e.g. Ollama cloud endpoint
  // unreachable). Without these, the error message "A connection attempt
  // failed because the connected party did not properly respond..." would
  // fall through to 'fatal' and skip retry, yet the outer teammate loop
  // would still blindly retry the same hung endpoint. Classifying as
  // transient makes the retry count explicit (4× with backoff).
  'wsarecv',
  'connection attempt failed',
  'did not properly respond',
  'established connection failed',
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

  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'auth';
  }

  if (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) {
    return 'model';
  }

  if (msg.includes('context') && msg.includes('exceed')) {
    return 'config';
  }

  if (isTransientError(err)) return 'transient';

  return 'fatal';
}

// ============================================================================
// Retry Configuration
// ============================================================================

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  firstTokenTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  firstTokenTimeoutMs: 20000,
  responseTimeoutMs: 120000,
};

/** Standard retryChat request shape used by all providers. */
export type RetryChatRequest = Omit<ChatRequest, 'stream'> & {
  stream?: false;
  /** Force tool choice for structured output (deepseek also reads this) */
  tool_choice?: 'none' | 'auto' | 'required' | string;
};

/** Standard retryChat config shape. */
export type RetryChatConfig = Partial<RetryConfig> & {
  signal?: AbortSignal;
  neglected?: boolean;
  noSpinner?: boolean;
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Signal-aware sleep. Resolves after `ms` milliseconds, OR rejects with
 * StreamAbortedError if the optional `signal` fires first.
 *
 * Used by retryChat's backoff between attempts so a watchdog abort can
 * interrupt the backoff immediately (without this, a hung endpoint keeps
 * the teammate stuck for the full backoff delay even after the watchdog
 * fires). Existing callers pass only `ms` and are unaffected (the signal
 * param is optional).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StreamAbortedError());
      return;
    }
    const timeoutId = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(new StreamAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig> & { timeoutMs?: number }
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    try {
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
      if (!isTransientError(err)) {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      const isLastAttempt = attempt > cfg.maxRetries;
      if (!isLastAttempt) {
        const delay = calculateDelay(attempt, cfg);
        agentIO.verbose('retry', `Attempt ${attempt}/${cfg.maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('All retry attempts failed');
}

// ============================================================================
// Spinner
// ============================================================================

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

export function startSpinner(prefix: string = 'Thinking'): void {
  if (spinnerInterval) return;

  process.stderr.write('\x1b[?25l');
  spinnerFrame = 0;
  spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    process.stderr.write(`\r${frame} ${prefix}...`);
    spinnerFrame++;
  }, 80);
}

export function stopSpinner(): void {
  if (!spinnerInterval) return;

  clearInterval(spinnerInterval);
  spinnerInterval = null;
  process.stderr.write('\r\x1b[K');
  process.stderr.write('\x1b[?25h');
}

// ============================================================================
// Stream Collection (provider-agnostic)
// ============================================================================

export class StreamTimeoutError extends Error {
  constructor(
    message: string,
    public readonly reason: 'first-token' | 'response',
  ) {
    super(message);
    this.name = 'StreamTimeoutError';
  }
}

export class StreamAbortedError extends Error {
  constructor(cause?: unknown) {
    super('Request aborted');
    this.name = 'StreamAbortedError';
    if (cause) this.cause = cause;
  }
}

export async function collectStream<T>(
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

  // Sentinel value for the abort promise — resolves instead of rejects
  // to avoid unhandled Promise rejections when abort wins the race.
  const ABORT_SENTINEL = Symbol('abort-sentinel');

  const abortPromise = signal
    ? new Promise<typeof ABORT_SENTINEL>((resolve) => {
        signal.addEventListener('abort', () => resolve(ABORT_SENTINEL), { once: true });
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

    const promises: Promise<T[] | typeof ABORT_SENTINEL>[] = [streamPromise];
    if (abortPromise) promises.push(abortPromise);

    const result = await Promise.race(promises);

    // If the abort sentinel won the race, throw — but only after the race
    // resolves, so the rejection is handled by the caller's await/catch.
    if (result === ABORT_SENTINEL) {
      throw new StreamAbortedError();
    }

    return result;
  } catch (err) {
    if (err instanceof StreamAbortedError) throw err;
    if (signal?.aborted) throw new StreamAbortedError(err instanceof Error ? err : undefined);
    throw err;
  } finally {
    cleanup();
  }
}
