/**
 * timeout-escalation.test.ts
 *
 * Regression test for the hard-conditioned 20s first-token timeout in
 * retryChat. Before the fix, DEFAULT_RETRY_CONFIG.firstTokenTimeoutMs=20000
 * was used unchanged on EVERY retry attempt in both ollama.ts and deepseek.ts.
 * A model needing >20s for its first token would fail all 4 attempts at the
 * identical 20s wall, throw to llm.ts, prompt the user, restart fresh at 20s
 * — an infinite failure loop.
 *
 * Fix: escalateFirstTokenTimeout() doubles the first-token timeout per
 * attempt (only when the previous attempt was a StreamTimeoutError), capped
 * at responseTimeoutMs (120s). Non-timeout transient errors keep the base.
 *
 * Coverage:
 *  1. escalateFirstTokenTimeout() unit tests (pure function).
 *  2. ollama.ts retryChat passes escalating timeouts to collectStream across
 *     attempts when early attempts throw StreamTimeoutError.
 *  3. ollama.ts retryChat keeps the base timeout when early attempts throw
 *     a non-timeout transient error (ECONNRESET).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (must be set up BEFORE importing modules that use them) ----------

// agentIO is imported eagerly by ollama.ts; stub it to a no-op surface so
// startSpinner/stopSpinner/verbose do not touch the real IO.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    brief: vi.fn(),
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the ollama client constructor's dependency surface. ollama.ts imports
// config getters (getOllamaHost, etc.) at module load; stub them to avoid
// touching real env / network.
vi.mock('../../config.js', () => ({
  getOllamaHost: vi.fn(() => 'http://127.0.0.1:11434'),
  getOllamaApiKey: vi.fn(() => ''),
  getOllamaModel: vi.fn(() => 'test-model'),
  getVisionModel: vi.fn(() => 'test-vision'),
  isVisionEnabled: vi.fn(() => false),
}));

// Mock the health-check probeModel import (not used by retryChat, but the
// module-level import in ollama.ts must resolve).
vi.mock('../../engine/health-check.js', () => ({
  probeModel: vi.fn(),
}));

// Mock the `ollama` package: replace the Ollama class so ollama.chat() returns
// a fake async-iterable stream object immediately (with an abort() no-op).
// retryChat races ollama.chat() (the POST) against a setTimeout keyed off the
// per-attempt timeout; if we let the real client run it hits the network. By
// resolving the POST instantly we reach collectStream (mocked below), where
// the per-attempt timeout is observable.
vi.mock('ollama', () => {
  function makeFakeStream() {
    return {
      abort() { /* no-op for tests */ },
      async *[Symbol.asyncIterator]() {
        // collectStream is mocked, so this iterator is never consumed.
        yield { message: { content: '' }, done: true, done_reason: 'stop' };
      },
    };
  }
  class Ollama {
    constructor(_opts: unknown) {}
    async chat(_req: unknown) { return makeFakeStream(); }
    async list() { return { models: [] }; }
    async show(_m: unknown) { return { model_info: {}, details: {} }; }
  }
  return { Ollama };
});

import {
  escalateFirstTokenTimeout,
  StreamTimeoutError,
  DEFAULT_RETRY_CONFIG,
} from '../../engine/chat-helpers.js';

// Collect the per-attempt firstTokenTimeoutMs values that ollama.ts's
// retryChat passes into collectStream, by mocking collectStream to record
// the config it receives and throw a controlled error per attempt.
const collectStreamCalls: Array<{ firstTokenTimeoutMs?: number }> = [];

// We import retryChat fresh per test by isolating the module registry so the
// collectStream mock can be (re)installed with a new behavior. Vitest's
// vi.resetModules() + dynamic import gives us a clean binding each time.
//
// IMPORTANT: vi.resetModules() gives ollama.ts a FRESH module instance, so the
// StreamTimeoutError class it checks with `instanceof` is a DIFFERENT class
// object than the one imported at the top of this test. If the mocked
// collectStream throws the top-imported StreamTimeoutError, ollama.ts's
// `err instanceof StreamTimeoutError` is false → previousWasTimeout stays
// false → no escalation. So loadOllamaRetryChat also returns the mocked
// module's StreamTimeoutError, and the test throws THAT class.
async function loadOllamaRetryChat(
  collectStreamImpl: (config: { firstTokenTimeoutMs?: number }) => Promise<unknown[]>,
): Promise<{
  retryChat: typeof import('../../engine/ollama.js')['retryChat'];
  StreamTimeoutError: typeof import('../../engine/chat-helpers.js')['StreamTimeoutError'];
}> {
  let exposedStreamTimeoutError: typeof import('../../engine/chat-helpers.js')['StreamTimeoutError'] | undefined;

  vi.doMock('../../engine/chat-helpers.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    exposedStreamTimeoutError = actual.StreamTimeoutError as typeof import('../../engine/chat-helpers.js')['StreamTimeoutError'];
    return {
      ...actual,
      // Override collectStream to record the timeout and delegate to the
      // per-test behavior. Keep all other real exports (escalateFirstTokenTimeout,
      // StreamTimeoutError, calculateDelay, sleep, etc.) from the original.
      collectStream: vi.fn(async (_stream: unknown, _abort: unknown, config: { firstTokenTimeoutMs?: number }) => {
        collectStreamCalls.push({ firstTokenTimeoutMs: config.firstTokenTimeoutMs });
        return collectStreamImpl(config);
      }),
    };
  });

  vi.resetModules();
  const mod = await import('../../engine/ollama.js');
  // Re-grab the (mocked) chat-helpers StreamTimeoutError so the test throws the
  // exact class object ollama.ts's instanceof check uses.
  if (!exposedStreamTimeoutError) {
    const helpers = await import('../../engine/chat-helpers.js');
    exposedStreamTimeoutError = (helpers as unknown as { StreamTimeoutError: typeof import('../../engine/chat-helpers.js')['StreamTimeoutError'] }).StreamTimeoutError;
  }
  return { retryChat: mod.retryChat, StreamTimeoutError: exposedStreamTimeoutError };
}

describe('escalateFirstTokenTimeout()', () => {
  const BASE = DEFAULT_RETRY_CONFIG.firstTokenTimeoutMs!; // 20000
  const CAP = DEFAULT_RETRY_CONFIG.responseTimeoutMs!;    // 120000

  it('should return the base timeout on attempt 1 regardless of previousWasTimeout', () => {
    expect(escalateFirstTokenTimeout(BASE, 1, CAP, false)).toBe(BASE);
    // Even if a caller claims a prior timeout, attempt 1 is the starting point.
    expect(escalateFirstTokenTimeout(BASE, 1, CAP, true)).toBe(BASE);
  });

  it('should double the timeout per attempt when previousWasTimeout=true (uncapped)', () => {
    // Use a large cap so the doubling is not clamped — verifies the multiplier.
    const bigCap = 1_000_000;
    expect(escalateFirstTokenTimeout(BASE, 2, bigCap, true)).toBe(BASE * 2);   // 40s
    expect(escalateFirstTokenTimeout(BASE, 3, bigCap, true)).toBe(BASE * 4);  // 80s
    expect(escalateFirstTokenTimeout(BASE, 4, bigCap, true)).toBe(BASE * 8); // 160s
  });

  it('should cap the timeout at responseTimeoutMs', () => {
    // BASE * 8 = 160000 > CAP (120000), so attempt 4 caps at 120s.
    expect(escalateFirstTokenTimeout(BASE, 4, CAP, true)).toBe(CAP);
    // A tighter cap kicks in earlier.
    expect(escalateFirstTokenTimeout(BASE, 3, 50000, true)).toBe(50000); // 80s capped to 50s
  });

  it('should keep the base timeout when previousWasTimeout=false (non-timeout error)', () => {
    // A connectivity error (ECONNRESET) should NOT extend the wait — more
    // time won't help. All attempts stay at the base.
    expect(escalateFirstTokenTimeout(BASE, 2, CAP, false)).toBe(BASE);
    expect(escalateFirstTokenTimeout(BASE, 3, CAP, false)).toBe(BASE);
    expect(escalateFirstTokenTimeout(BASE, 4, CAP, false)).toBe(BASE);
  });
});

describe('ollama.ts retryChat — escalating first-token timeout across attempts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectStreamCalls.length = 0;
  });

  afterEach(() => {
    vi.doUnmock('../../engine/chat-helpers.js');
    vi.resetModules();
  });

  it('should pass escalating timeouts to collectStream when early attempts time out on first token', async () => {
    const { retryChat, StreamTimeoutError: MockedSTE } = await loadOllamaRetryChat(async (config) => {
      // First two attempts: first-token timeout. Third: succeed.
      // The escalating ceiling must allow attempt 2 (40s) and attempt 3 (80s)
      // — we model the "slow model finally returns" as success on attempt 3.
      const idx = collectStreamCalls.length; // 0-based before this push? No:
      // collectStreamCalls.push happened above, so length is already 1-based for this call.
      if (idx <= 2) {
        throw new MockedSTE(
          `Request timed out after ${config.firstTokenTimeoutMs}ms (waiting for first token)`,
          'first-token',
        );
      }
      return [{ message: { content: 'ok' }, done: true, done_reason: 'stop' }];
    });

    // Real timers are fine here: the POST race (Promise.race between the
    // mocked ollama.chat(), which resolves instantly, and a per-attempt
    // setTimeout) is won by the mocked chat immediately, so no real 20s
    // wait occurs. The backoff sleep uses baseDelayMs=0 → resolves next tick.
    const response = await retryChat(
      { model: 'test-model', messages: [] },
      // Force a tiny backoff so sleep resolves immediately.
      { baseDelayMs: 0, maxDelayMs: 0, noSpinner: true },
    );

    // 3 collectStream calls: attempt 1 (20s), 2 (40s), 3 (80s).
    expect(collectStreamCalls).toHaveLength(3);
    expect(collectStreamCalls[0].firstTokenTimeoutMs).toBe(20000);
    expect(collectStreamCalls[1].firstTokenTimeoutMs).toBe(40000);
    expect(collectStreamCalls[2].firstTokenTimeoutMs).toBe(80000);
    expect(response.message?.content).toBe('ok');
  });

  it('should keep the base timeout when early attempts fail with a non-timeout transient error', async () => {
    const { retryChat } = await loadOllamaRetryChat(async (_config) => {
      // All attempts fail with a transient connectivity error (ECONNRESET).
      // Escalation must NOT kick in — every attempt stays at the base 20s.
      const err = new Error('fetch failed: ECONNRESET');
      throw err;
    });

    // After maxRetries+1 attempts (4) all fail with the same transient error,
    // retryChat throws it out. Real timers (see rationale above) finish fast.
    await expect(
      retryChat(
        { model: 'test-model', messages: [] },
        { baseDelayMs: 0, maxDelayMs: 0, noSpinner: true },
      ),
    ).rejects.toThrow(/ECONNRESET/);

    // 4 collectStream calls, all at the base 20s — no escalation.
    expect(collectStreamCalls).toHaveLength(4);
    for (const call of collectStreamCalls) {
      expect(call.firstTokenTimeoutMs).toBe(20000);
    }
  });
});