/**
 * compact-wrapup-stale-mark.test.ts
 *
 * Regression test for the "Cannot read properties of undefined (reading 'role')"
 * crash that occurs after /compact when a wrap-up turn (ESC interrupt) was
 * active.
 *
 * Root cause (confirmed by parallel audit of all .role call sites):
 *   compact() replaced this.messages with a 2-message summary but did NOT
 *   reset this.wrapUpMark. If beginWrapUp() had set wrapUpMark to the
 *   pre-compact length (e.g. 50), a later rollbackWrapUp() (triggered from
 *   prompt.ts:385-393 when hasActiveWrapUp() is still true) ran
 *   `this.messages.length = wrapUpMark` (= 50) on the now-2-element array,
 *   stretching it to length 50 with 48 undefined sparse holes. The next raw
 *   reader of this.messages — minifyMessages(this.messages) in runAutoCompact
 *   (triologue.ts:853) — read `msg.role` on an undefined hole and threw
 *   "Cannot read properties of undefined (reading 'role')".
 *
 * Fix (defense in depth, verified here):
 *  1. compact() resets this.wrapUpMark = -1 after replacing this.messages —
 *     compaction invalidates any active wrap-up turn (the context it was part
 *     of no longer exists). This is the root-cause fix.
 *  2. rollbackWrapUp() guards `this.messages.length = this.wrapUpMark` so it
 *     never STRETCHES the array (only truncates when wrapUpMark < length).
 *     This is the safety net against any future stale-mark source.
 *
 * This test reconstructs the crash chain (beginWrapUp → compact → rollback)
 * and asserts neither the invariant violation nor the crash can recur.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    brief: vi.fn(),
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config so runAutoCompact's getSessionContext/getSessionDir return safe
// values instead of throwing "Session context not initialized". Must also
// include getOllamaModel (ollama.ts reads it at module load: `export const
// MODEL = getOllamaModel()`) and the other config fns chat-provider/ollama
// import eagerly. Mirrors the exhaustive list in tp-fix.test.ts.
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isDebuggingTp: () => false,
    getApiProvider: () => 'ollama',
    getOllamaModel: () => 'test-model',
    getOllamaHost: () => 'http://localhost:11434',
    getOllamaApiKey: () => undefined,
    getDeepSeekHost: () => 'https://api.deepseek.com',
    getDeepSeekApiKey: () => undefined,
    getDeepSeekModel: () => 'deepseek-chat',
    getLongtextDir: () => '/tmp/.mycc/longtext',
    ensureDirs: () => {},
    getTokenThreshold: () => 50000,
    isVerbose: () => false,
    getSessionContext: () => 'test-session',
    getSessionDir: () => '/tmp/.mycc/sessions/test-session',
    setSessionContext: () => {},
  };
});

// Mock fs so runAutoCompact's transcript-write (createWriteStream, existsSync,
// mkdirSync) does not touch the real filesystem.
vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: () => {},
  createWriteStream: () => ({ write: () => {}, end: () => {} }),
  writeFileSync: () => {},
  readFileSync: () => '',
  appendFileSync: () => {},
  default: {
    existsSync: () => true,
    mkdirSync: () => {},
    createWriteStream: () => ({ write: () => {}, end: () => {} }),
    writeFileSync: () => {},
    readFileSync: () => '',
    appendFileSync: () => {},
  },
}));

vi.mock('../../engine/ollama.js', () => ({
  retryChat: vi.fn().mockResolvedValue({ message: { content: 'summary' } }),
  retryMultipleChoice: vi.fn(),
  webSearch: vi.fn(),
  webFetch: vi.fn(),
  imgDescribe: vi.fn(),
  readPictureCached: vi.fn(),
  structuredChat: vi.fn(),
  healthCheck: vi.fn(),
  getEmbedding: vi.fn(),
  MODEL: 'test-model',
}));

// chat-provider.ts re-exports from ollama.ts at module load, and runAutoCompact
// imports retryChat/MODEL/forkChat FROM chat-provider.js. Mock chat-provider
// directly so those re-exports resolve to the stubbed retryChat (no real HTTP),
// not the real ollama binding. forkChat is stubbed to resolve '' (runAutoCompact
// calls it only when `tools` is non-empty; compact() in these tests omits tools).
vi.mock('../../engine/chat-provider.js', () => ({
  retryChat: vi.fn().mockResolvedValue({ message: { content: 'summary' } }),
  forkChat: vi.fn().mockResolvedValue(''),
  MODEL: 'test-model',
  retryMultipleChoice: vi.fn(),
  healthCheck: vi.fn(),
}));

import { Triologue } from '../../loop/triologue.js';
import { minifyMessages } from '../../utils/llm-chat-minifier.js';

interface TriologueInternals {
  /** Build a conversation of n user/assistant turns via the PUBLIC API. */
  seedTurns: (n: number) => void;
  /** Live snapshot of the conversation length. */
  messageCount: () => number;
  wrapUpMark: number;
}

function internals(t: Triologue): TriologueInternals {
  // Phase 2 refactor: messages live in the private MessageStore. White-box
  // array poking is replaced by public-API seeding + length reads, so the
  // regression scenario (long conversation → wrap-up → compact → rollback)
  // is reproduced through the same surface production code uses.
  return {
    seedTurns: (n: number) => {
      for (let i = 0; i < n; i++) {
        t.user(`q${i}`);
        t.agent(`a${i}`);
      }
    },
    messageCount: () => t.getMessagesRaw().length,
    get wrapUpMark(): number {
      return (t as unknown as { wrapUp: { value: number } }).wrapUp.value;
    },
    set wrapUpMark(value: number) {
      const mgr = (t as unknown as { wrapUp: { value: number; commit(): void; reset(): void; begin(n: number): void } }).wrapUp;
      if (value === -1) {
        mgr.reset();
      } else {
        mgr.begin(value);
      }
    },
  };
}

describe('compact() resets wrapUpMark — stale-mark sparse-hole crash', () => {
  let t: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    t = new Triologue();
  });

  it('compact() should reset wrapUpMark to -1 (root-cause fix)', async () => {
    // Build a conversation long enough that wrapUpMark is meaningfully large.
    internals(t).seedTurns(24);
    t.beginWrapUp(); // sets wrapUpMark = message count (49), appends [WRAP_UP]
    expect(internals(t).wrapUpMark).toBeGreaterThan(2);

    await t.compact();

    // Root-cause fix: compact invalidates the active wrap-up turn.
    expect(internals(t).wrapUpMark).toBe(-1);
    expect(t.hasActiveWrapUp()).toBe(false);
  });

  it('rollbackWrapUp() after compact must NOT leave sparse undefined holes', async () => {
    internals(t).seedTurns(24);
    t.beginWrapUp();
    await t.compact();

    // Simulate prompt.ts:385-393 grace-period rollback path.
    if (t.hasActiveWrapUp()) {
      t.rollbackWrapUp();
    }

    // Array must NOT be stretched: length stays at the compacted size (<=2).
    expect(internals(t).messageCount()).toBeLessThanOrEqual(2);
    // No undefined/null/non-object holes — the crash seed.
    const messages = t.getMessagesRaw();
    for (let i = 0; i < messages.length; i++) {
      expect(messages[i]).toBeDefined();
      expect(messages[i]).not.toBeNull();
      expect(typeof messages[i]).toBe('object');
      expect((messages[i] as { role?: unknown }).role).toBeDefined();
    }
  });

  it('no reader crashes on the post-compact-then-rollback array', async () => {
    internals(t).seedTurns(24);
    t.beginWrapUp();
    await t.compact();
    if (t.hasActiveWrapUp()) {
      t.rollbackWrapUp();
    }

    // Every reader that consumes the messages must not throw reading 'role'.
    expect(() => t.getLastRole()).not.toThrow();
    expect(() => t.getMessages()).not.toThrow();
    expect(() => t.getMessagesRaw()).not.toThrow();
    // The confirmed crash function: minifyMessages on the RAW array.
    expect(() => minifyMessages(t.getMessagesRaw())).not.toThrow();
  });

  it('rollbackWrapUp() never stretches the array (safety-net guard)', async () => {
    // Directly test the safety net: forge a stale mark larger than the array,
    // then rollback — must NOT stretch.
    t.user('only');
    // Simulate a stale mark (as if compact left it dangling at 50).
    internals(t).wrapUpMark = 50;
    expect(internals(t).messageCount()).toBe(1);

    t.rollbackWrapUp();

    // Safety net: length stays 1, NOT 50. No holes created.
    expect(internals(t).messageCount()).toBe(1);
    expect(t.getMessagesRaw()[0]).toBeDefined();
    expect((t.getMessagesRaw()[0] as { role?: unknown }).role).toBe('user');
    expect(internals(t).wrapUpMark).toBe(-1);
  });
});