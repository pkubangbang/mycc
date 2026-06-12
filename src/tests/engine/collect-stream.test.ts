/**
 * collect-stream.test.ts - Unit tests for collectStream abort race condition
 *
 * Verifies that when the abort sentinel wins Promise.race, no unhandled
 * rejection occurs (the sentinel resolves instead of rejecting).
 */

import { describe, test, afterEach } from 'vitest';
import { expect } from 'chai';
import { collectStream, StreamAbortedError } from '../../engine/chat-helpers.js';

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
});
