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
import { isTransientError, classifyError } from '../../engine/chat-helpers.js';

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