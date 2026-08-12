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
import type { Message } from '../../types.js';

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
// import eagerly. Mirrors the exhaustive list in tp-auto-fixer.test.ts.
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
  messages: Message[];
  wrapUpMark: number;
}

function internals(t: Triologue): TriologueInternals {
  return t as unknown as TriologueInternals;
}

describe('compact() resets wrapUpMark — stale-mark sparse-hole crash', () => {
  let t: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    t = new Triologue();
  });

  it('compact() should reset wrapUpMark to -1 (root-cause fix)', async () => {
    // Build a conversation long enough that wrapUpMark is meaningfully large.
    const { messages } = internals(t);
    for (let i = 0; i < 24; i++) {
      messages.push({ role: 'user', content: `q${i}` } as Message);
      messages.push({ role: 'assistant', content: `a${i}` } as Message);
    }
    t.beginWrapUp(); // sets wrapUpMark = messages.length (49), appends [WRAP_UP]
    expect(internals(t).wrapUpMark).toBeGreaterThan(2);

    await t.compact();

    // Root-cause fix: compact invalidates the active wrap-up turn.
    expect(internals(t).wrapUpMark).toBe(-1);
    expect(t.hasActiveWrapUp()).toBe(false);
  });

  it('rollbackWrapUp() after compact must NOT leave sparse undefined holes', async () => {
    const { messages: before } = internals(t);
    for (let i = 0; i < 24; i++) {
      before.push({ role: 'user', content: `q${i}` } as Message);
      before.push({ role: 'assistant', content: `a${i}` } as Message);
    }
    t.beginWrapUp();
    await t.compact();
    // Re-read AFTER compact — compact() does `this.messages = compacted`, so
    // the pre-compact array reference is stale. internals() returns the live one.
    const messages = internals(t).messages;

    // Simulate prompt.ts:385-393 grace-period rollback path.
    if (t.hasActiveWrapUp()) {
      t.rollbackWrapUp();
    }

    // Array must NOT be stretched: length stays at the compacted size (<=2).
    expect(messages.length).toBeLessThanOrEqual(2);
    // No undefined/null/non-object holes — the crash seed.
    for (let i = 0; i < messages.length; i++) {
      expect(messages[i]).toBeDefined();
      expect(messages[i]).not.toBeNull();
      expect(typeof messages[i]).toBe('object');
      expect((messages[i] as { role?: unknown }).role).toBeDefined();
    }
  });

  it('no reader crashes on the post-compact-then-rollback array', async () => {
    const { messages: before } = internals(t);
    for (let i = 0; i < 24; i++) {
      before.push({ role: 'user', content: `q${i}` } as Message);
      before.push({ role: 'assistant', content: `a${i}` } as Message);
    }
    t.beginWrapUp();
    await t.compact();
    const messages = internals(t).messages;
    if (t.hasActiveWrapUp()) {
      t.rollbackWrapUp();
    }

    // Every reader that consumes this.messages must not throw reading 'role'.
    expect(() => t.getLastRole()).not.toThrow();
    expect(() => t.getMessages()).not.toThrow();
    expect(() => t.getMessagesRaw()).not.toThrow();
    // The confirmed crash function: minifyMessages on the RAW array.
    expect(() => minifyMessages(messages)).not.toThrow();
  });

  it('rollbackWrapUp() never stretches the array (safety-net guard)', async () => {
    // Directly test the safety net: forge a stale mark larger than the array,
    // then rollback — must NOT stretch.
    const { messages, wrapUpMark } = internals(t);
    messages.push({ role: 'user', content: 'only' } as Message);
    // Simulate a stale mark (as if compact left it dangling at 50).
    (t as unknown as { wrapUpMark: number }).wrapUpMark = 50;
    expect(messages.length).toBe(1);

    t.rollbackWrapUp();

    // Safety net: length stays 1, NOT 50. No holes created.
    expect(messages.length).toBe(1);
    expect(messages[0]).toBeDefined();
    expect((messages[0] as { role?: unknown }).role).toBe('user');
    expect(internals(t).wrapUpMark).toBe(-1);
  });
});