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
 *  4. ollama.ts retryChat escalates BOTH liveness windows (response +
 *     thinking) across attempts when early attempts throw StreamTimeoutError,
 *     mirroring the first-token escalation. The thinking window is wider
 *     than the response window and both double per attempt (capped at
 *     responseTimeoutMs). Regression for the bug where a stalled-during-
 *     stream LLM hit the identical fixed liveness wall on every retry and
 *     could never resume.
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
  DEFAULT_RETRY_CONFIG,
} from '../../engine/chat-helpers.js';

// Collect the per-attempt config values that ollama.ts's retryChat passes
// into collectStream, by mocking collectStream to record the config it
// receives and throw a controlled error per attempt. We capture:
//  - firstTokenTimeoutMs: the per-attempt first-token wait (escalated).
//  - tokenLivenessTimeoutMs: the per-attempt RESPONSE liveness window
//    (escalated; passed as a direct config field by ollama.ts).
//  - livenessMsForChunk: the per-chunk classifier closure. ollama.ts does
//    NOT pass the THINKING liveness window as a direct config field — it
//    bakes the escalated thinking value into the classifier closure
//    (returns attemptThinkingLivenessMs for thinking-only chunks). So to
//    observe the thinking window we capture the classifier and invoke it
//    with a synthetic thinking-only chunk (mirrors ollama.ts's own field
//    check: message.thinking set, message.content empty).
const collectStreamCalls: Array<{
  firstTokenTimeoutMs?: number;
  tokenLivenessTimeoutMs?: number;
  livenessMsForChunk?: (chunk: unknown) => number | undefined;
}> = [];

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
  collectStreamImpl: (config: {
    firstTokenTimeoutMs?: number;
    tokenLivenessTimeoutMs?: number;
    livenessMsForChunk?: (chunk: unknown) => number | undefined;
  }) => Promise<unknown[]>,
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
      // Override collectStream to record the per-attempt timeouts and delegate
      // to the per-test behavior. Keep all other real exports
      // (escalateFirstTokenTimeout, StreamTimeoutError, calculateDelay, sleep,
      // etc.) from the original. ollama.ts passes tokenLivenessTimeoutMs (the
      // escalated RESPONSE window) as a direct config field, and bakes the
      // escalated THINKING window into the livenessMsForChunk closure (it is
      // NOT a separate config field — the classifier returns it for
      // thinking-only chunks). We capture the classifier so the tests can
      // invoke it with a synthetic thinking-only chunk and read out the
      // thinking window, exactly as collectStream does at runtime.
      collectStream: vi.fn(async (
        _stream: unknown,
        _abort: unknown,
        config: {
          firstTokenTimeoutMs?: number;
          tokenLivenessTimeoutMs?: number;
          livenessMsForChunk?: (chunk: unknown) => number | undefined;
        },
      ) => {
        collectStreamCalls.push({
          firstTokenTimeoutMs: config.firstTokenTimeoutMs,
          tokenLivenessTimeoutMs: config.tokenLivenessTimeoutMs,
          livenessMsForChunk: config.livenessMsForChunk,
        });
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

/**
 * Read the THINKING liveness window that ollama.ts baked into a captured
 * livenessMsForChunk classifier, by invoking it with a synthetic thinking-
 * only chunk (message.thinking set, message.content empty) — the exact
 * field shape ollama.ts's classifier checks. Returns undefined if no
 * classifier was captured for that call (should not happen for retryChat).
 */
function thinkingWindowFromCall(call: { livenessMsForChunk?: (chunk: unknown) => number | undefined }): number | undefined {
  return call.livenessMsForChunk?.({ message: { thinking: 'reasoning', content: '' } });
}

/**
 * Read the RESPONSE liveness window from a captured classifier, by invoking
 * it with a synthetic response-only chunk (message.content set, no thinking).
 */
function responseWindowFromCall(call: { livenessMsForChunk?: (chunk: unknown) => number | undefined }): number | undefined {
  return call.livenessMsForChunk?.({ message: { content: 'response' } });
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

  it('should escalate BOTH liveness windows (response + thinking) across attempts when early attempts time out', async () => {
    // Regression for the streaming-liveness bug: the inter-token liveness
    // timeout was FIXED across retry attempts (unlike the first-token timeout
    // which IS escalated). Once a cloud model stalled mid-stream for >10s,
    // all 4 retries hit the identical 10s wall and the LLM could never
    // resume. The fix escalates BOTH liveness windows per attempt (mirroring
    // escalateFirstTokenTimeout), with the thinking window wider than the
    // response window (reasoning is slower with longer intermissions).
    const { retryChat, StreamTimeoutError: MockedSTE } = await loadOllamaRetryChat(async (config) => {
      // First two attempts: liveness timeout (reason 'liveness'). Third: succeed.
      const idx = collectStreamCalls.length;
      if (idx <= 2) {
        throw new MockedSTE(
          `Stream stalled: no token received for ${config.tokenLivenessTimeoutMs}ms`,
          'liveness',
        );
      }
      return [{ message: { content: 'ok' }, done: true, done_reason: 'stop' }];
    });

    const response = await retryChat(
      { model: 'test-model', messages: [] },
      { baseDelayMs: 0, maxDelayMs: 0, noSpinner: true },
    );

    // 3 collectStream calls across attempts 1, 2, 3.
    expect(collectStreamCalls).toHaveLength(3);

    // Response liveness window: 10s → 20s → 40s (doubles per attempt).
    // Read directly from the config field ollama.ts passes.
    expect(collectStreamCalls[0].tokenLivenessTimeoutMs).toBe(10000);
    expect(collectStreamCalls[1].tokenLivenessTimeoutMs).toBe(20000);
    expect(collectStreamCalls[2].tokenLivenessTimeoutMs).toBe(40000);
    // Cross-check: the classifier returns the same value for a response chunk.
    expect(responseWindowFromCall(collectStreamCalls[0])).toBe(10000);

    // Thinking liveness window: 30s → 60s → 120s (doubles per attempt, and is
    // ALWAYS wider than the response window on the same attempt). ollama.ts
    // bakes the escalated thinking value into the livenessMsForChunk closure
    // (it is NOT a separate config field), so we read it by invoking the
    // classifier with a synthetic thinking-only chunk.
    expect(thinkingWindowFromCall(collectStreamCalls[0])).toBe(30000);
    expect(thinkingWindowFromCall(collectStreamCalls[1])).toBe(60000);
    expect(thinkingWindowFromCall(collectStreamCalls[2])).toBe(120000);

    // Invariant: the thinking window is strictly wider than the response
    // window on every attempt (the phase-aware fix is meaningful only if
    // this holds — otherwise thinking chunks get no extra tolerance).
    for (const call of collectStreamCalls) {
      expect(thinkingWindowFromCall(call)).toBeGreaterThan(
        call.tokenLivenessTimeoutMs!,
      );
    }

    expect(response.message?.content).toBe('ok');
  });

  it('should keep BOTH liveness windows at the base when early attempts fail with a non-timeout transient error', async () => {
    // Companion to the non-timeout first-token test: a connectivity error
    // (ECONNRESET) must NOT escalate the liveness windows either — more
    // time won't help a connectivity issue. All attempts stay at the base
    // (response 10s, thinking 30s).
    const { retryChat } = await loadOllamaRetryChat(async (_config) => {
      throw new Error('fetch failed: ECONNRESET');
    });

    await expect(
      retryChat(
        { model: 'test-model', messages: [] },
        { baseDelayMs: 0, maxDelayMs: 0, noSpinner: true },
      ),
    ).rejects.toThrow(/ECONNRESET/);

    expect(collectStreamCalls).toHaveLength(4);
    for (const call of collectStreamCalls) {
      expect(call.tokenLivenessTimeoutMs).toBe(10000);
      // Thinking window read from the classifier closure (base 30s, not escalated).
      expect(thinkingWindowFromCall(call)).toBe(30000);
    }
  });

  it('should cap the liveness windows at responseTimeoutMs on later attempts', async () => {
    // With the default cap (120s), the response liveness doubles 10→20→40→80s
    // across 4 attempts (never hits the cap). But the thinking liveness
    // doubles 30→60→120→240s — attempt 4 (240s) exceeds the 120s cap and must
    // be clamped. Verify the cap is respected so liveness never exceeds the
    // first-token escalation ceiling (which would let a stalled stream run
    // far longer than the configured response budget).
    const { retryChat, StreamTimeoutError: MockedSTE } = await loadOllamaRetryChat(async (_config) => {
      // All 4 attempts fail with a liveness timeout.
      throw new MockedSTE(
        'Stream stalled: no token received',
        'liveness',
      );
    });

    await expect(
      retryChat(
        { model: 'test-model', messages: [] },
        { baseDelayMs: 0, maxDelayMs: 0, noSpinner: true },
      ),
    ).rejects.toThrow(/stalled/);

    // 4 attempts: response 10→20→40→80 (under cap); thinking 30→60→120→120 (capped).
    expect(collectStreamCalls).toHaveLength(4);
    expect(collectStreamCalls[0].tokenLivenessTimeoutMs).toBe(10000);
    expect(collectStreamCalls[1].tokenLivenessTimeoutMs).toBe(20000);
    expect(collectStreamCalls[2].tokenLivenessTimeoutMs).toBe(40000);
    expect(collectStreamCalls[3].tokenLivenessTimeoutMs).toBe(80000);

    // Thinking window read from the classifier closure (baked in by ollama.ts).
    expect(thinkingWindowFromCall(collectStreamCalls[0])).toBe(30000);
    expect(thinkingWindowFromCall(collectStreamCalls[1])).toBe(60000);
    expect(thinkingWindowFromCall(collectStreamCalls[2])).toBe(120000);
    // Attempt 4: 30 * 2^3 = 240s, capped at responseTimeoutMs (120s).
    expect(thinkingWindowFromCall(collectStreamCalls[3])).toBe(120000);
  });
});