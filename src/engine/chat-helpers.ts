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
  // Ollama library: AbortableAsyncIterator throws this when the HTTP stream
  // ends WITHOUT a final chunk carrying done:true (or status:"success"). It
  // is the symptom of a premature mid-stream connection close — the server
  // (often Ollama cloud) dropped the SSE/fetch body before sending the
  // terminator. This is a recoverable network condition (same family as
  // 'premature close' / 'unexpected eof' above), but its literal message
  // shares no substring with any existing pattern, so without this entry
  // isTransientError() returns false → classifyError() returns 'fatal' →
  // retryChat's `if (!isTransientError(err)) throw err;` rethrows on the
  // FIRST attempt with zero retries. The error then bubbles to the COLLECT
  // catch, which logs it and returns to PROMPT — silently aborting the
  // in-flight hint round (or chat) instead of retrying the dropped stream.
  'did not receive done or success response in stream',
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

/**
 * Default inter-token liveness window for RESPONSE chunks. The liveness
 * timer is reset on every streamed chunk; if no chunk arrives within this
 * window the stream is considered stalled and aborted. This replaces the
 * former hard total-cap (responseTimeoutMs=120s) so a slow-but-steady
 * stream that keeps producing tokens can finish in the long run instead of
 * being killed mid-generation at an arbitrary wall-clock ceiling.
 *
 * `responseTimeoutMs` on {@link RetryConfig} is retained, but only as the
 * escalation ceiling for {@link escalateFirstTokenTimeout} (the first-token
 * timeout doubles per retry attempt, capped at responseTimeoutMs). It is no
 * longer a total-response cap inside collectStream.
 */
export const DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS = 10_000;

/**
 * Default inter-token liveness window for THINKING chunks (reasoning_content
 * / thinking). The thinking process is by design slower than the real
 * responding process and has a bigger spur — more tokens between longer
 * intermissions. A cloud server may pause scheduling during a long reasoning
 * chain for longer than the response window without the stream being dead.
 * This wider window (30s) tolerates such a normal thinking-phase pause so the
 * stream is not killed mid-reasoning, losing all streamed thinking tokens and
 * forcing a from-scratch retry. A genuine stall (no chunk of any kind for 30s
 * during thinking) still trips.
 */
export const DEFAULT_THINKING_LIVENESS_TIMEOUT_MS = 30_000;

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  firstTokenTimeoutMs?: number;
  responseTimeoutMs?: number;
  /**
   * Inter-token liveness window for RESPONSE chunks (content, not thinking).
   * Response generation should produce tokens steadily; a gap longer than
   * this is a genuine stall. Defaults to
   * {@link DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS} (10s).
   */
  tokenLivenessTimeoutMs?: number;
  /**
   * Inter-token liveness window for THINKING chunks (reasoning_content /
   * thinking). The thinking process is by design slower than responding and
   * has a bigger spur — more tokens between longer intermissions — so it
   * gets a more tolerant window. A normal server-side scheduling pause
   * during a long reasoning chain should not kill the stream. Defaults to
   * {@link DEFAULT_THINKING_LIVENESS_TIMEOUT_MS} (30s).
   */
  thinkingLivenessTimeoutMs?: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  firstTokenTimeoutMs: 20000,
  responseTimeoutMs: 120000,
  tokenLivenessTimeoutMs: DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS,
  thinkingLivenessTimeoutMs: DEFAULT_THINKING_LIVENESS_TIMEOUT_MS,
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

/**
 * Compute an escalated first-token timeout for the current retry attempt.
 *
 * When the previous attempt failed with a first-token timeout, double the
 * base timeout for the next attempt, capped at responseTimeoutMs. This
 * prevents a slow model from hitting the same 20s wall on every retry —
 * without it, all 4 attempts fail at the identical timeout and the call
 * can never make out (infinite retry loop reported by users).
 *
 * Non-timeout errors (e.g. ECONNRESET) keep the base timeout — more time
 * won't help a connectivity issue, so we don't waste wall-clock escalating
 * for errors that are independent of first-token latency.
 *
 * @param baseMs - The base first-token timeout (attempt 1 value).
 * @param attempt - 1-based attempt number in the retry loop.
 * @param capMs - Upper bound (typically responseTimeoutMs).
 * @param previousWasTimeout - Whether the previous attempt threw StreamTimeoutError.
 * @returns The timeout to use for this attempt's first-token wait.
 */
export function escalateFirstTokenTimeout(
  baseMs: number,
  attempt: number,
  capMs: number,
  previousWasTimeout: boolean,
): number {
  if (!previousWasTimeout) return baseMs;
  const multiplier = Math.pow(2, attempt - 1);
  return Math.min(baseMs * multiplier, capMs);
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
// Time + token statistics for the "thinking..." spinner. Reset in
// startSpinner, incremented via updateSpinnerTokens by the LLM stream's
// onChunk callback, and read every frame to render the live suffix
// "(27s, 4505 tokens)" once the wait exceeds 5 seconds.
let spinnerStartTime = 0;
let spinnerTokenCount = 0;
const SPINNER_STATS_THRESHOLD_S = 5;

export function startSpinner(prefix: string = 'Thinking'): void {
  if (spinnerInterval) return;

  process.stderr.write('\x1b[?25l');
  spinnerFrame = 0;
  spinnerStartTime = Date.now();
  spinnerTokenCount = 0;
  spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const elapsedS = Math.floor((Date.now() - spinnerStartTime) / 1000);
    // Only show time/token stats after the wait exceeds the threshold so
    // short responses keep the clean "⠋ thinking..." line. When stats are
    // shown, omit the token count if it is still 0 (e.g. health-check
    // spinners that have no LLM stream feeding tokens) to avoid a
    // misleading "(0 tokens)".
    let line: string;
    if (elapsedS >= SPINNER_STATS_THRESHOLD_S) {
      line = spinnerTokenCount > 0
        ? `\r${frame} ${prefix}... (${elapsedS}s, ${spinnerTokenCount.toLocaleString()} tokens)`
        : `\r${frame} ${prefix}... (${elapsedS}s)`;
    } else {
      line = `\r${frame} ${prefix}...`;
    }
    process.stderr.write(line);
    spinnerFrame++;
  }, 80);
}

/**
 * Increment the running spinner's token counter by `delta`.
 *
 * Called by the LLM stream's per-chunk callback (wired in ollama.ts /
 * deepseek.ts via collectStream's onChunk option) so each streamed chunk's
 * text is estimated and the spinner's live "(N tokens)" suffix updates
 * every frame. Safe to call when no spinner is running (noSpinner path or
 * before startSpinner): it only mutates the module-level counter, which
 * startSpinner resets to 0 on the next spin, so stray increments are
 * harmless.
 */
export function updateSpinnerTokens(delta: number): void {
  if (delta > 0) spinnerTokenCount += delta;
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
    public readonly reason: 'first-token' | 'liveness',
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
    /**
     * Inter-token liveness window. The timer is reset on every chunk; if no
     * chunk arrives within this window the stream is considered stalled and
     * aborted. Defaults to {@link DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS} (10s).
     * A slow-but-steady stream keeps resetting the timer and never trips.
     *
     * This is the BASE/fallback window. When {@link livenessMsForChunk} is
     * also supplied, it is called on each chunk to pick a per-chunk window
     * (e.g. a wider window for thinking chunks, a tighter one for response
     * chunks); the value returned overrides this for the window that
     * follows that chunk. The initial window (before the first chunk) is
     * always this base value.
     */
    tokenLivenessTimeoutMs?: number;
    /**
     * Optional per-chunk liveness classifier. Called on every chunk right
     * before the liveness timer is (re)armed; its return value becomes the
     * liveness window for the gap that follows this chunk. Return
     * `undefined` to keep the current window unchanged (e.g. for a chunk
     * that carries neither thinking nor response text).
     *
     * This lets a provider apply a MORE TOLERANT window during the thinking
     * phase (reasoning is slower with longer intermissions) and a TIGHTER
     * window during the response phase, without collectStream needing to
     * know provider-specific chunk field names. The provider already
     * inspects each chunk's fields in its `onChunk` callback, so the
     * classifier is a small lambda delegating to the same field checks.
     */
    livenessMsForChunk?: (chunk: T) => number | undefined;
    signal?: AbortSignal;
    /** Optional per-chunk callback invoked right after each chunk is
     *  collected. Used by the LLM providers to feed incremental token
     *  estimates into the spinner's live "(N tokens)" counter via
     *  updateSpinnerTokens. Receives the raw chunk; the provider decides
     *  which fields to estimate. Not invoked on abort or timeout. */
    onChunk?: (chunk: T) => void;
  },
): Promise<T[]> {
  const { firstTokenTimeoutMs, tokenLivenessTimeoutMs, livenessMsForChunk, signal, onChunk } = config;
  const baseLivenessMs = tokenLivenessTimeoutMs ?? DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS;
  // The currently-active liveness window. Initialized to the base; updated
  // per chunk by livenessMsForChunk (e.g. widened for thinking chunks,
  // tightened for response chunks). Used in armLiveness() and in the
  // StreamTimeoutError messages.
  let currentLivenessMs = baseLivenessMs;

  let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let livenessTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let firstTokenReceived = false;
  let firstTokenTimeoutFired = false;
  let livenessTimeoutFired = false;

  const armLiveness = () => {
    if (livenessTimeoutId) clearTimeout(livenessTimeoutId);
    livenessTimeoutId = setTimeout(() => {
      livenessTimeoutFired = true;
      abort?.();
    }, currentLivenessMs);
  };

  const cleanup = () => {
    if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId);
    if (livenessTimeoutId) clearTimeout(livenessTimeoutId);
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

  // Arm the liveness timer at stream start. It is reset on every chunk below
  // so a stream that keeps producing tokens (even slowly) never trips it;
  // only a genuine stall (no chunk for `livenessMs`) fires it. This replaces
  // the former one-shot total cap (responseTimeoutMs) that killed slow
  // streams mid-generation at an arbitrary wall-clock ceiling.
  armLiveness();

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
        onChunk?.(chunk);

        // Per-chunk liveness classification: the provider's classifier (if
        // supplied) picks the window for the gap that follows this chunk —
        // e.g. a wider window for a thinking chunk, a tighter one for a
        // response chunk. `undefined` keeps the current window (e.g. for a
        // done-only chunk carrying neither thinking nor response text).
        if (livenessMsForChunk) {
          const ms = livenessMsForChunk(chunk);
          if (ms !== undefined) currentLivenessMs = ms;
        }

        // Reset the liveness timer on every chunk — a stream that keeps
        // producing tokens (even slowly) never trips it. Only a genuine
        // stall (no chunk for the current window) fires it.
        armLiveness();

        if (signal?.aborted) throw new StreamAbortedError();
      }

      if (firstTokenTimeoutFired) {
        throw new StreamTimeoutError(
          `Request timed out after ${firstTokenTimeoutMs}ms (waiting for first token)`,
          'first-token',
        );
      }
      if (livenessTimeoutFired) {
        throw new StreamTimeoutError(
          `Stream stalled: no token received for ${currentLivenessMs}ms`,
          'liveness',
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
    // Timeout-induced abort: the first-token / response timeout callbacks call
    // abort?.() which makes the for-await loop throw a raw reader-cancel error
    // (NOT StreamAbortedError). Without these checks the raw cancel error
    // falls through to `throw err` below, so retryWithBackoff's
    // isTransientError() never sees a StreamTimeoutError → no retry/escalation
    // (all 4 retries hit the same wall once and fail). Convert the raw cancel
    // error into the proper StreamTimeoutError so retry escalation works.
    // These checks must run BEFORE the signal?.aborted check: the timeout
    // aborts the stream reader, not the user-supplied AbortSignal, so
    // signal?.aborted is false here.
    if (firstTokenTimeoutFired) {
      throw new StreamTimeoutError(
        `Request timed out after ${firstTokenTimeoutMs}ms (waiting for first token)`,
        'first-token',
      );
    }
    if (livenessTimeoutFired) {
      throw new StreamTimeoutError(
        `Stream stalled: no token received for ${currentLivenessMs}ms`,
        'liveness',
      );
    }
    if (signal?.aborted) throw new StreamAbortedError(err instanceof Error ? err : undefined);
    throw err;
  } finally {
    cleanup();
  }
}
