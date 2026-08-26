/**
 * collect-stream.test.ts - Unit tests for collectStream abort race condition
 *
 * Verifies that when the abort sentinel wins Promise.race, no unhandled
 * rejection occurs (the sentinel resolves instead of rejecting).
 */

import { describe, test, afterEach } from 'vitest';
import { expect } from 'chai';
import { collectStream, StreamAbortedError, StreamTimeoutError } from '../../engine/chat-helpers.js';

/**
 * Create an async iterable that yields items then rejects after a delay.
 */
async function* makeDelayedIterable<T>(
  items: T[],
  opts: { rejectAfterMs?: number; error?: Error } = {},
): AsyncIterable<T> {
  const { rejectAfterMs, error } = opts;
  const start = Date.now();
  for (const item of items) {
    const elapsed = Date.now() - start;
    if (rejectAfterMs !== undefined && elapsed >= rejectAfterMs) {
      throw error ?? new Error('Simulated stream error');
    }
    yield item;
    // Yield to the event loop
    await new Promise((r) => setTimeout(r, 5));
  }
  if (rejectAfterMs !== undefined) {
    const remaining = rejectAfterMs - (Date.now() - start);
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, remaining));
    }
    throw error ?? new Error('Simulated stream error');
  }
}

describe('collectStream — abort race condition', () => {
  let unhandledRejectionCount = 0;
  let prevHandler: ((reason: unknown) => void) | null = null;

  afterEach(() => {
    if (prevHandler) {
      process.removeListener('unhandledRejection', prevHandler);
      prevHandler = null;
    }
  });

  function trackUnhandledRejections() {
    unhandledRejectionCount = 0;
    prevHandler = (_reason: unknown) => {
      unhandledRejectionCount++;
    };
    process.on('unhandledRejection', prevHandler);
  }

  test('should NOT produce unhandled rejection when abort wins the race', async () => {
    trackUnhandledRejections();

    const controller = new AbortController();

    // Endless stream that keeps yielding chunks
    async function* abortableStream() {
      let i = 0;
      while (true) {
        i++;
        yield `chunk-${i}`;
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    const resultPromise = collectStream(abortableStream(), () => {}, {
      signal: controller.signal,
    });

    // Let the stream start, then abort
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    // Should reject with StreamAbortedError
    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw StreamAbortedError');
    } catch (err) {
      expect(err).to.be.instanceOf(StreamAbortedError);
    }

    // Give the event loop time to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(unhandledRejectionCount).to.equal(0,
      'Expected 0 unhandled rejections when abort wins collectStream Promise.race');
  });

  test('should NOT produce unhandled rejection when stream rejects asynchronously after abort', async () => {
    trackUnhandledRejections();

    const controller = new AbortController();

    // Stream that delivers a few chunks then rejects asynchronously
    const stream = makeDelayedIterable(
      ['a', 'b', 'c'],
      { rejectAfterMs: 40, error: new Error('Simulated I/O error after abort') },
    );

    const resultPromise = collectStream(stream, () => {}, {
      signal: controller.signal,
    });

    // Abort before the stream rejects naturally — sentinel should win
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw StreamAbortedError');
    } catch (err) {
      expect(err).to.be.instanceOf(StreamAbortedError);
    }

    // Give the event loop time for the async stream rejection to fire
    await new Promise((r) => setTimeout(r, 100));

    expect(unhandledRejectionCount).to.equal(0,
      'Expected 0 unhandled rejections when stream rejects after abort wins race');
  });

  test('should still propagate stream errors when no abort occurs', async () => {
    trackUnhandledRejections();

    const controller = new AbortController();
    const streamError = new Error('Natural stream failure');

    const stream = makeDelayedIterable(
      ['a', 'b'],
      { rejectAfterMs: 20, error: streamError },
    );

    const resultPromise = collectStream(stream, () => {}, {
      signal: controller.signal,
    });

    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw');
    } catch (err) {
      expect((err as Error).message).to.equal('Natural stream failure');
    }

    await new Promise((r) => setTimeout(r, 30));
    expect(unhandledRejectionCount).to.equal(0);
  });

  test('should collect all chunks when no abort occurs', async () => {
    const controller = new AbortController();
    async function* simpleIterable() {
      yield 'hello';
      yield 'world';
    }

    const result = await collectStream(simpleIterable(), () => {}, {
      signal: controller.signal,
    });

    expect(result).to.deep.equal(['hello', 'world']);
  });

  test('should throw StreamTimeoutError (not raw cancel error) on first-token timeout', async () => {
    // Bug fix: the first-token timeout callback calls abort?.(), which makes
    // the for-await loop throw a raw reader-cancel error (NOT
    // StreamAbortedError). Without the firstTokenTimeoutFired check in the
    // catch block, the raw cancel error fell through to `throw err`, so
    // retryWithBackoff's isTransientError() never saw a StreamTimeoutError
    // and retry escalation failed. This test verifies the catch block now
    // converts the raw cancel into a StreamTimeoutError.
    const controller = new AbortController();

    // A stream that never yields a first token. Its .next() rejects with a
    // raw cancel error when abort() is called — mirroring how Ollama's
    // reader.cancel propagates through the async iterator.
    let cancelFn: (() => void) | null = null;
    async function* hangingStream(): AsyncIterable<string> {
      await new Promise<void>((_, reject) => {
        // .next() hangs until cancel() rejects it with a raw error.
        cancelFn = () => reject(new Error('The reader has been cancelled'));
      });
      // unreachable — the above promise rejects
    }

    let abortCalled = false;
    const abortFn = () => {
      abortCalled = true;
      // Cancel the hanging .next() — this makes the for-await loop throw the
      // raw cancel error, exactly as the real reader.cancel does.
      cancelFn?.();
    };

    const resultPromise = collectStream(hangingStream(), abortFn, {
      signal: controller.signal,
      firstTokenTimeoutMs: 20, // very short so the timeout fires quickly
    });

    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw StreamTimeoutError');
    } catch (err) {
      // The fix: the catch block checks firstTokenTimeoutFired and throws
      // StreamTimeoutError instead of the raw cancel error.
      expect(err).to.be.instanceOf(StreamTimeoutError);
      expect((err as StreamTimeoutError).message).to.include('first token');
    }
    expect(abortCalled).to.be.true;
  });

  test('should throw StreamTimeoutError on response timeout (not raw cancel error)', async () => {
    // Companion to the first-token timeout test: the response timeout fires
    // after the first token arrived but before the stream completed. The
    // catch block must convert the raw cancel into a StreamTimeoutError too.
    const controller = new AbortController();

    // A stream that yields one chunk (first token) then hangs forever. Its
    // second .next() rejects with a raw cancel error when abort() is called.
    let cancelFn: (() => void) | null = null;
    async function* oneThenHangStream(): AsyncIterable<string> {
      yield 'first'; // first token received
      await new Promise<void>((_, reject) => {
        cancelFn = () => reject(new Error('The reader has been cancelled'));
      });
      // unreachable
    }

    let abortCalled = false;
    const abortFn = () => {
      abortCalled = true;
      cancelFn?.();
    };

    const resultPromise = collectStream(oneThenHangStream(), abortFn, {
      signal: controller.signal,
      firstTokenTimeoutMs: 10000, // large so first-token timeout does not fire
      responseTimeoutMs: 20,      // short so response timeout fires quickly
    });

    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw StreamTimeoutError');
    } catch (err) {
      expect(err).to.be.instanceOf(StreamTimeoutError);
      expect((err as StreamTimeoutError).message).to.include('Response');
    }
    expect(abortCalled).to.be.true;
  });
});
