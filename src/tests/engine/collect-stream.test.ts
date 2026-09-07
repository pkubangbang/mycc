/**
 * collect-stream.test.ts - Unit tests for collectStream abort race condition
 *
 * Verifies that when the abort sentinel wins Promise.race, no unhandled
 * rejection occurs (the sentinel resolves instead of rejecting).
 */

import { describe, test, afterEach } from 'vitest';
import { expect } from 'chai';
import {
  collectStream,
  StreamAbortedError,
  StreamTimeoutError,
  DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS,
  DEFAULT_THINKING_LIVENESS_TIMEOUT_MS,
} from '../../engine/chat-helpers.js';

/**
 * A chunk shape that mirrors both providers: a `phase` tag identifies
 * whether the chunk carries thinking text, response text, both, or neither.
 * The livenessMsForChunk classifier below maps phase → window, exactly as
 * ollama.ts (message.thinking / message.content) and deepseek.ts
 * (delta.reasoning_content / delta.content) do.
 */
interface PhaseChunk {
  phase: 'thinking' | 'response' | 'both' | 'neither';
  text: string;
}

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

  test('should throw StreamTimeoutError on liveness timeout (not raw cancel error)', async () => {
    // Companion to the first-token timeout test: the liveness timeout fires
    // after the first token arrived but then NO further chunk arrives within
    // the liveness window. The catch block must convert the raw cancel into
    // a StreamTimeoutError too.
    //
    // Semantics: the liveness timer is reset on EVERY chunk, so a slow-but-
    // steady stream never trips it — only a genuine stall (no chunk for the
    // window) fires. This replaced the former one-shot total cap
    // (responseTimeoutMs) that killed slow streams mid-generation.
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
      tokenLivenessTimeoutMs: 20, // short so liveness timeout fires quickly
    });

    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw StreamTimeoutError');
    } catch (err) {
      expect(err).to.be.instanceOf(StreamTimeoutError);
      expect((err as StreamTimeoutError).message).to.include('stalled');
    }
    expect(abortCalled).to.be.true;
  });

  // ─── Phase-aware liveness (thinking vs response) ───────────────────────
  //
  // The user-reported bug: thinking/reasoning tokens are inherently slower
  // with longer intermissions between larger spurts. A fixed 10s liveness
  // window (the response default) kills a normal thinking-phase pause on
  // every retry, so a stalled-during-thinking LLM can never resume. The fix
  // gives thinking chunks a wider window (30s default) via the per-chunk
  // livenessMsForChunk classifier, while response chunks keep the tight 10s
  // window. These two tests pin that behavior:
  //   1. A thinking-phase gap that exceeds the RESPONSE window but is under
  //      the THINKING window SURVIVES — the stream is not killed mid-reasoning.
  //   2. A response-phase gap that exceeds the RESPONSE window TRIPS — the
  //      model is producing visible output and a gap here is a genuine stall.

  /**
   * Build a stream that yields an initial chunk, then waits `gapMs` before
   * the next chunk. The initial chunk's `phase` sets the active liveness
   * window (via the classifier); the gap is what the test exercises.
   */
  function makeStreamWithGap(
    firstPhase: PhaseChunk['phase'],
    gapMs: number,
  ): { stream: AsyncIterable<PhaseChunk>; cancelFn: () => void } {
    let cancelFn: () => void = () => {};
    async function* gen(): AsyncIterable<PhaseChunk> {
      yield { phase: firstPhase, text: 'first' };
      // Hold the gap; if abort fires during it, reject with a raw cancel
      // error (mirrors reader.cancel propagating through the async iterator).
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, gapMs);
        cancelFn = () => {
          clearTimeout(t);
          reject(new Error('The reader has been cancelled'));
        };
      });
      yield { phase: firstPhase, text: 'second' };
    }
    return { stream: gen(), cancelFn: () => cancelFn() };
  }

  /**
   * The phase classifier used by both tests — mirrors ollama.ts
   * (message.thinking / message.content) and deepseek.ts
   * (delta.reasoning_content / delta.content): a chunk carrying response
   * content gets the tight window; a chunk carrying only thinking gets the
   * wide window; neither preserves the current window.
   */
  function phaseClassifier(
    chunk: PhaseChunk,
    responseMs: number,
    thinkingMs: number,
  ): number | undefined {
    if (chunk.phase === 'response' || chunk.phase === 'both') return responseMs;
    if (chunk.phase === 'thinking') return thinkingMs;
    return undefined;
  }

  test('phase-aware liveness: a thinking gap under the THINKING window survives (would trip the RESPONSE window)', async () => {
    // A gap of 60ms. The RESPONSE window is 30ms (would trip); the THINKING
    // window is 200ms (survives). With phase-aware liveness the thinking
    // chunk widens the window to 200ms, so the 60ms gap does NOT trip and
    // the stream completes. This is the core fix: a normal thinking-phase
    // pause is no longer killed mid-reasoning.
    const controller = new AbortController();
    const { stream, cancelFn } = makeStreamWithGap('thinking', 60);

    const abortFn = () => cancelFn();
    const result = await collectStream(stream, abortFn, {
      signal: controller.signal,
      firstTokenTimeoutMs: 10000, // large; first token arrives immediately anyway
      tokenLivenessTimeoutMs: 30, // base/response window (tight)
      livenessMsForChunk: (c: PhaseChunk) =>
        phaseClassifier(c, 30, 200), // thinking → 200ms wide window
    });

    // Stream completed: both chunks collected, no liveness trip.
    expect(result).to.have.lengthOf(2);
    expect(result[0].text).to.equal('first');
    expect(result[1].text).to.equal('second');
  });

  test('phase-aware liveness: a response gap over the RESPONSE window trips (tight window enforced)', async () => {
    // Same 60ms gap, but now the chunk is a RESPONSE chunk. The classifier
    // applies the tight 30ms window, so the 60ms gap EXCEEDS it and the
    // liveness timer fires → StreamTimeoutError. This guards the other half:
    // response generation should flow steadily; a gap here is a real stall.
    const controller = new AbortController();
    const { stream, cancelFn } = makeStreamWithGap('response', 60);

    let abortCalled = false;
    const abortFn = () => {
      abortCalled = true;
      cancelFn();
    };

    const resultPromise = collectStream(stream, abortFn, {
      signal: controller.signal,
      firstTokenTimeoutMs: 10000, // large; first token arrives immediately
      tokenLivenessTimeoutMs: 30, // base/response window (tight)
      livenessMsForChunk: (c: PhaseChunk) =>
        phaseClassifier(c, 30, 200), // response → 30ms tight window
    });

    try {
      await resultPromise;
      expect.fail('Expected collectStream to throw StreamTimeoutError');
    } catch (err) {
      expect(err).to.be.instanceOf(StreamTimeoutError);
      expect((err as StreamTimeoutError).message).to.include('stalled');
      // The stalled window reported is the active RESPONSE window (30ms),
      // not the thinking window — confirms the classifier selected tight.
      expect((err as StreamTimeoutError).message).to.include('30ms');
    }
    expect(abortCalled).to.be.true;
  });

  test('DEFAULT_THINKING_LIVENESS_TIMEOUT_MS is wider than DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS', async () => {
    // Guard constant: the thinking window must be strictly wider than the
    // response window, or the phase-aware fix is a no-op. If someone
    // accidentally equalizes them, the thinking-phase pause protection
    // disappears and the original bug returns.
    expect(DEFAULT_THINKING_LIVENESS_TIMEOUT_MS).to.be.greaterThan(
      DEFAULT_TOKEN_LIVENESS_TIMEOUT_MS,
    );
  });
});
