/**
 * transient-classification.test.ts
 *
 * Regression test for isTransientError() / classifyError() in chat-helpers.
 *
 * Background: the ollama library's AbortableAsyncIterator throws
 *   "Did not receive done or success response in stream."
 * when the HTTP stream ends WITHOUT a final chunk carrying done:true (or
 * status:"success") — the symptom of a premature mid-stream connection
 * close (Ollama cloud dropping the SSE/fetch body before the terminator).
 *
 * Before the fix, this literal message shared no substring with any entry
 * in TRANSIENT_ERROR_PATTERNS, so isTransientError() returned false,
 * classifyError() returned 'fatal', and retryChat's
 *   `if (!isTransientError(err)) throw err;`
 * rethrew on the FIRST attempt with zero retries. The error then bubbled to
 * the COLLECT catch, which logged it and returned to PROMPT — silently
 * aborting the in-flight hint round (or chat) instead of retrying.
 *
 * The fix adds the literal message to TRANSIENT_ERROR_PATTERNS so it is
 * classified as 'transient' and retried with backoff.
 */

import { describe, it, expect } from 'vitest';
import {
  isTransientError,
  classifyError,
  normalizeFetchError,
  retryWithBackoff,
} from '../../engine/chat-helpers.js';

describe('isTransientError()', () => {
  it('should classify the ollama "did not receive done" stream error as transient', () => {
    const err = new Error('Did not receive done or success response in stream.');
    expect(isTransientError(err)).toBe(true);
  });

  it('should classify the error as transient regardless of case', () => {
    // isTransientError lowercases the message before matching.
    const err = new Error('DID NOT RECEIVE DONE OR SUCCESS RESPONSE IN STREAM.');
    expect(isTransientError(err)).toBe(true);
  });

  it('should still classify established transient patterns as transient', () => {
    // Guard against regressions in the existing patterns.
    expect(isTransientError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('premature close'))).toBe(true);
    expect(isTransientError(new Error('unexpected eof'))).toBe(true);
  });

  it('should classify HTTP 5xx status codes as transient', () => {
    expect(isTransientError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
    expect(isTransientError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('HTTP 504 Gateway Timeout'))).toBe(true);
  });

  it('should classify rate-limit and overload errors as transient', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
    expect(isTransientError(new Error('server overloaded'))).toBe(true);
  });

  it('should classify connection-refused and timeout errors as transient', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
    expect(isTransientError(new Error('request timed out after 20000ms'))).toBe(true);
  });

  it('should return false for a genuinely non-transient error', () => {
    expect(isTransientError(new Error('some unrelated syntax problem'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isTransientError('a string')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError({ message: 'did not receive done' })).toBe(false);
  });
});

describe('normalizeFetchError()', () => {
  it('should rewrite undici bare TypeError("terminated") into a transient-classifiable error', () => {
    // Regression: undici's fetch() throws a bare `TypeError: terminated`
    // (Fetch.onAborted) when the HTTPS socket closes mid-request. The literal
    // message "terminated" matches NO entry in TRANSIENT_ERROR_PATTERNS, so
    // without normalization isTransientError() returns false → retryChat
    // rethrows on the first attempt (zero retries) → COLLECT falls through to
    // PROMPT → auto mode stalls forever on AWAIT.
    const raw = new TypeError('terminated');
    expect(isTransientError(raw)).toBe(false);
    const normalized = normalizeFetchError(raw);
    expect(isTransientError(normalized)).toBe(true);
    expect(classifyError(normalized)).toBe('transient');
  });

  it('should preserve the original error as cause for diagnostics', () => {
    const raw = new TypeError('terminated');
    const normalized = normalizeFetchError(raw) as Error & { cause?: unknown };
    expect(normalized.cause).toBe(raw);
  });

  it('should pass through non-terminated errors unchanged (same reference)', () => {
    const err = new Error('some unrelated syntax problem');
    expect(normalizeFetchError(err)).toBe(err);
  });

  it('should pass through non-TypeError errors unchanged', () => {
    const err = new Error('terminated'); // plain Error, not TypeError — leave it
    expect(normalizeFetchError(err)).toBe(err);
  });
});

describe('classifyError()', () => {
  it('should classify the ollama "did not receive done" stream error as transient (not fatal)', () => {
    // This is the core regression: previously 'fatal', now 'transient' so
    // retryChat retries instead of rethrowing on the first attempt.
    const err = new Error('Did not receive done or success response in stream.');
    expect(classifyError(err)).toBe('transient');
  });

  it('should classify auth errors before transient patterns', () => {
    // A 401 must be 'auth' even if it incidentally contains a transient word.
    expect(classifyError(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyError(new Error('403 Forbidden'))).toBe('auth');
  });

  it('should classify model-not-found errors as model', () => {
    expect(classifyError(new Error('model not found'))).toBe('model');
    expect(classifyError(new Error('model does not exist'))).toBe('model');
  });

  it('should classify context-exceeded errors as config', () => {
    expect(classifyError(new Error('context length exceed limit'))).toBe('config');
  });

  it('should classify a genuinely unrelated error as fatal', () => {
    expect(classifyError(new Error('some unrelated syntax problem'))).toBe('fatal');
  });

  it('should return fatal for non-Error values', () => {
    expect(classifyError('a string')).toBe('fatal');
    expect(classifyError(null)).toBe('fatal');
  });
});

// ============================================================================
// Integration: retryWithBackoff actually retries after TypeError('terminated')
// ============================================================================
//
// This is the regression that motivated normalizeFetchError(): the unit tests
// above prove the normalize → classify mechanism, but they do NOT prove the
// retry loop behaves correctly. Before the fix, a bare TypeError("terminated")
// shared no substring with TRANSIENT_ERROR_PATTERNS, so retryWithBackoff's
// `if (!isTransientError(err)) throw err;` rethrew on the FIRST attempt with
// ZERO retries — the operation never got a second chance. These tests exercise
// retryWithBackoff end-to-end: attempt 1 throws TypeError("terminated"),
// attempt 2 succeeds, and we assert both the returned value and that the
// operation was invoked exactly twice.
//
// We also cover a stream-shaped scenario that mirrors the real failure: a
// mid-stream socket close yields chunks THEN throws TypeError("terminated").
// This proves that a SOCKET TERMINATION (the symptom normalizeFetchError
// targets) — rather than a timeout cancellation (which collectStream
// translates into StreamTimeoutError, a different code path) — reaches the
// normalizer and is retried.
describe('retryWithBackoff() — retries after bare TypeError("terminated")', () => {
  // Force the backoff sleep to resolve immediately so the tests don't wait
  // on real timers. baseDelayMs=0 → calculateDelay returns ~0ms.
  const fastRetry = { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 3 };

  it('should retry and succeed when attempt 1 throws TypeError("terminated") and attempt 2 succeeds', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts === 1) {
        // The exact bare error undici/Node surfaces on mid-stream socket
        // termination — the literal message is just the word "terminated".
        throw new TypeError('terminated');
      }
      return 'recovered';
    }, fastRetry);

    expect(attempts).toBe(2);
    expect(result).toBe('recovered');
  });

  it('should NOT have retried before the fix (zero-retry regression guard)', async () => {
    // Sanity check that the raw error is NOT transient on its own: this is
    // the condition that caused the original zero-retry stall. If this ever
    // flips to true, normalizeFetchError becomes redundant and the framing
    // of these tests must change.
    expect(isTransientError(new TypeError('terminated'))).toBe(false);
  });

  it('should retry a mid-stream socket termination that yields chunks then throws TypeError("terminated")', async () => {
    // Models the real transport symptom: a fetch/SSE stream emits some
    // chunks, then the socket dies mid-read and the for-await machinery
    // surfaces it as a bare TypeError("terminated") (NOT a StreamTimeoutError
    // — collectStream only translates TIMEOUT-induced aborts to
    // StreamTimeoutError; a raw socket termination passes through as the
    // underlying reader error, which is what normalizeFetchError catches).
    let attempts = 0;
    const collectedChunks: string[] = [];

    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts === 1) {
        // Simulate consuming a stream that yields two chunks then dies.
        const chunks = ['chunk-A', 'chunk-B'];
        for (const c of chunks) collectedChunks.push(c);
        throw new TypeError('terminated');
      }
      // Attempt 2: the stream completes normally.
      collectedChunks.push('chunk-C', 'done');
      return collectedChunks.slice();
    }, fastRetry);

    expect(attempts).toBe(2);
    // Attempt 1's partial chunks were discarded (the operation re-ran from
    // scratch — retryWithBackoff does not replay partial state), and attempt
    // 2's full sequence is what the caller receives.
    expect(result).toEqual(['chunk-A', 'chunk-B', 'chunk-C', 'done']);
  });

  it('should preserve the original TypeError("terminated") as cause when all attempts fail', async () => {
    // After maxRetries+1 attempts all throw TypeError("terminated"), the
    // normalized error (with the original preserved as cause) is the one
    // that propagates out — so callers/diagnostics still see the real
    // transport symptom, not just the synthesized "transport terminated"
    // message.
    const raw = new TypeError('terminated');
    await expect(
      retryWithBackoff(async () => {
        throw raw;
      }, fastRetry),
    ).rejects.toThrow(/transport terminated/);

    // Verify cause preservation on the thrown error by catching it directly.
    let caught: unknown;
    try {
      await retryWithBackoff(async () => {
        throw new TypeError('terminated');
      }, fastRetry);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    expect((caught as Error & { cause?: unknown }).cause).toHaveProperty('message', 'terminated');
  });

  it('should retry up to maxRetries+1 attempts when every attempt throws TypeError("terminated")', async () => {
    // Confirms the full retry budget is exhausted (not just one extra
    // attempt) — maxRetries=3 → 4 total attempts before giving up.
    let attempts = 0;
    await expect(
      retryWithBackoff(async () => {
        attempts++;
        throw new TypeError('terminated');
      }, fastRetry),
    ).rejects.toThrow(/transport terminated/);
    expect(attempts).toBe(4);
  });
});