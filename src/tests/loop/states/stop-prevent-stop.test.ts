/**
 * stop-prevent-stop.test.ts - Unit tests for the STOP-stage stop guard.
 *
 * Two layers:
 *  1. `parsePreventStopResult` — the tolerant JSON parser behind the forkChat
 *     boundary (surrounding noise tolerated, non-array rejected, never throws).
 *  2. `checkPreventStop` — the gate policy: one batched forkChat for all
 *     guards, the hash anti-hallucination check, and the FAIL-OPEN contract
 *     (no candidates / throw / non-JSON / all-false → the turn may end).
 *
 * The gate deliberately has NO hold counter: a guard is released by the agent
 * un-pinning the todo, never by the system capping it — so "holds forever" is
 * asserted explicitly below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// chat-provider: forkChat is the only LLM boundary the gate touches.
vi.mock('../../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(async () => '[]'),
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

// loader: only getToolsForScope is read (to pass the tool schema to forkChat).
vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ type: 'function', function: { name: 'bash' } }]) },
}));

import { parsePreventStopResult, checkPreventStop, extractJsonArrayCandidates } from '../../../loop/states/stop-prevent-stop.js';
import { forkChat } from '../../../engine/chat-provider.js';
import type { MachineEnv } from '../../../loop/state-machine.js';
import type { TodoItem } from '../../../types.js';

describe('parsePreventStopResult', () => {
  it('should parse a clean JSON array', () => {
    const raw = '[{"id":2,"hash":"abc12345","hold":true,"reason":"tests still failing"}]';
    expect(parsePreventStopResult(raw)).toEqual([
      { id: 2, hash: 'abc12345', hold: true, reason: 'tests still failing' },
    ]);
  });

  it('should parse multiple entries', () => {
    const raw = '[{"id":1,"hash":"h1","hold":false,"reason":"satisfied"},{"id":2,"hash":"h2","hold":true,"reason":"pending"}]';
    expect(parsePreventStopResult(raw)).toEqual([
      { id: 1, hash: 'h1', hold: false, reason: 'satisfied' },
      { id: 2, hash: 'h2', hold: true, reason: 'pending' },
    ]);
  });

  it('should extract a JSON array from surrounding noise text', () => {
    const raw = 'Here is my evaluation:\n[{"id":2,"hash":"abc","hold":true,"reason":"x"}]\nHope that helps!';
    expect(parsePreventStopResult(raw)).toEqual([
      { id: 2, hash: 'abc', hold: true, reason: 'x' },
    ]);
  });

  it('should return null for non-JSON text', () => {
    expect(parsePreventStopResult('HOLD because tests fail')).toBeNull();
    expect(parsePreventStopResult('')).toBeNull();
    expect(parsePreventStopResult('   ')).toBeNull();
  });

  it('should return null for JSON that is not an array', () => {
    expect(parsePreventStopResult('{"id":2,"hold":true}')).toBeNull();
    expect(parsePreventStopResult('"just a string"')).toBeNull();
    expect(parsePreventStopResult('42')).toBeNull();
  });

  it('should return null for malformed JSON array (unclosed)', () => {
    expect(parsePreventStopResult('[{"id":2,"hold":true')).toBeNull();
  });

  it('should tolerate whitespace around the JSON array', () => {
    const raw = '   \n  [{"id":5,"hash":"h","hold":false,"reason":"skip"}]  \n  ';
    expect(parsePreventStopResult(raw)).toEqual([
      { id: 5, hash: 'h', hold: false, reason: 'skip' },
    ]);
  });

  it('should keep entries even if some fields are missing (caller guards per-entry)', () => {
    expect(parsePreventStopResult('[{"id":2,"hash":"abc","hold":true}]')).toEqual([
      { id: 2, hash: 'abc', hold: true, reason: undefined },
    ]);
  });
});

// ── checkPreventStop gate policy ─────────────────────────────────────────────

/** Candidate fixture: an open pinned todo carrying a guard. */
function guarded(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 3,
    name: 'Keep the loop green',
    done: false,
    hash: 'aaaa1111',
    pinned: true,
    preventStop: 'until every test under src/loop passes',
    ...overrides,
  };
}

/** Build the minimal MachineEnv the gate reads. */
function makeEnv(candidates: TodoItem[]): MachineEnv {
  return {
    scope: 'main',
    triologue: {
      getMessages: vi.fn(() => [{ role: 'user', content: 'go' }]),
      note: vi.fn(),
    },
    ctx: {
      todo: { getPreventStopCandidates: vi.fn(() => candidates) },
      core: {
        escAware: vi.fn(async (fn: (ac: AbortController) => Promise<unknown>) => fn(new AbortController())),
        verbose: vi.fn(),
      },
    },
    // Other env members are not touched by the gate.
  } as unknown as MachineEnv;
}

describe('checkPreventStop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(forkChat).mockResolvedValue('[]');
  });

  it('should not call forkChat when there are no guards', async () => {
    const verdict = await checkPreventStop(makeEnv([]));
    expect(verdict).toEqual({ block: false });
    expect(forkChat).not.toHaveBeenCalled();
  });

  it('should block when the evaluator holds a guard, and name the reason', async () => {
    const c = guarded();
    vi.mocked(forkChat).mockResolvedValue(
      `[{"id":${c.id},"hash":"${c.hash}","hold":true,"reason":"3 tests still fail"}]`,
    );
    const verdict = await checkPreventStop(makeEnv([c]));
    expect(verdict.block).toBe(true);
    expect(verdict.note).toContain('#3');
    expect(verdict.note).toContain(c.preventStop!);
    expect(verdict.note).toContain('3 tests still fail');
    expect(verdict.note).toContain('unpin #3');
  });

  it('should send ONE batched forkChat for multiple guards', async () => {
    const a = guarded({ id: 1, hash: 'h1', name: 'A', preventStop: 'cond-a' });
    const b = guarded({ id: 2, hash: 'h2', name: 'B', preventStop: 'cond-b' });
    vi.mocked(forkChat).mockResolvedValue(
      '[{"id":1,"hash":"h1","hold":false,"reason":"done"},{"id":2,"hash":"h2","hold":false,"reason":"done"}]',
    );
    await checkPreventStop(makeEnv([a, b]));
    expect(forkChat).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(forkChat).mock.calls[0][2] as string;
    expect(prompt).toContain('cond-a');
    expect(prompt).toContain('cond-b');
  });

  it('should allow the turn to end when every guard is released', async () => {
    const c = guarded();
    vi.mocked(forkChat).mockResolvedValue(`[{"id":${c.id},"hash":"${c.hash}","hold":false,"reason":"green"}]`);
    expect((await checkPreventStop(makeEnv([c]))).block).toBe(false);
  });

  it('should fail open when forkChat throws', async () => {
    vi.mocked(forkChat).mockRejectedValue(new Error('TLS timeout'));
    const verdict = await checkPreventStop(makeEnv([guarded()]));
    expect(verdict.block).toBe(false);
  });

  it('should fail open when the reply is not JSON', async () => {
    vi.mocked(forkChat).mockResolvedValue('yes, keep going!');
    expect((await checkPreventStop(makeEnv([guarded()]))).block).toBe(false);
  });

  it('should fail open on ESC (escAware returns the empty-string fallback)', async () => {
    const env = makeEnv([guarded()]);
    (env.ctx.core.escAware as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('');
    expect((await checkPreventStop(env)).block).toBe(false);
  });

  it('should ignore a hold entry whose hash does not match (anti-hallucination)', async () => {
    const c = guarded();
    vi.mocked(forkChat).mockResolvedValue(`[{"id":${c.id},"hash":"deadbeef","hold":true,"reason":"made up"}]`);
    expect((await checkPreventStop(makeEnv([c]))).block).toBe(false);
  });

  it('should ignore malformed entries without throwing', async () => {
    vi.mocked(forkChat).mockResolvedValue('[{"id":"3","hash":42,"hold":"yes"},{}]');
    expect((await checkPreventStop(makeEnv([guarded()]))).block).toBe(false);
  });

  it('should report the TOPMOST held guard when several are held', async () => {
    const a = guarded({ id: 1, hash: 'h1', name: 'A', preventStop: 'cond-a' });
    const b = guarded({ id: 2, hash: 'h2', name: 'B', preventStop: 'cond-b' });
    vi.mocked(forkChat).mockResolvedValue(
      '[{"id":1,"hash":"h1","hold":true,"reason":"reason-a"},{"id":2,"hash":"h2","hold":true,"reason":"reason-b"}]',
    );
    const verdict = await checkPreventStop(makeEnv([a, b]));
    expect(verdict.block).toBe(true);
    expect(verdict.note).toContain('cond-a');
    expect(verdict.note).not.toContain('reason-b');
  });

  it('should keep blocking on repeated holds — there is no safety cap', async () => {
    const c = guarded();
    const reply = `[{"id":${c.id},"hash":"${c.hash}","hold":true,"reason":"still working"}]`;
    vi.mocked(forkChat).mockResolvedValue(reply);
    const env = makeEnv([c]);
    // Five consecutive STOP entries: the guard is unbounded by design — the
    // agent's escape is un-pinning, not a system-imposed ceiling.
    for (let i = 0; i < 5; i++) {
      expect((await checkPreventStop(env)).block).toBe(true);
    }
  });

  it('should never mutate the todo (gate, not a reopen)', async () => {
    const c = guarded();
    const env = makeEnv([c]);
    (env.ctx.todo as unknown as Record<string, unknown>).updateTodo = vi.fn();
    vi.mocked(forkChat).mockResolvedValue(`[{"id":${c.id},"hash":"${c.hash}","hold":true,"reason":"x"}]`);
    await checkPreventStop(env);
    expect((env.ctx.todo as unknown as Record<string, unknown>).updateTodo).not.toHaveBeenCalled();
  });
});

describe('checkPreventStop — hash echo and recovery (review 2026-10-24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(forkChat).mockResolvedValue('[]');
  });

  it('should PRINT each guard hash so the evaluator can echo it (regression: guard was inert)', async () => {
    // The evaluator cannot recall a hash from the transcript: hashes appear only
    // in tool results and the throttled todo nudge, and compaction wipes the
    // transcript entirely. The prompt must therefore carry them.
    const c = guarded({ id: 7, hash: 'deadbeef', name: 'migrate', preventStop: 'until verified' });
    vi.mocked(forkChat).mockResolvedValue('[]');
    await checkPreventStop(makeEnv([c]));
    const prompt = vi.mocked(forkChat).mock.calls[0][2] as string;
    expect(prompt).toContain('[hash: deadbeef]');
  });

  it('should accept an honest hash taken from the prompt (end-to-end match)', async () => {
    const c = guarded({ id: 7, hash: 'deadbeef' });
    const env = makeEnv([c]);
    // Simulate a model that copies the hash it was shown.
    vi.mocked(forkChat).mockImplementation(async (_m, _t, prompt) => {
      const shown = /\[hash: ([0-9a-f]+)\]/.exec(prompt as string)?.[1];
      return `[{"id":7,"hash":"${shown}","hold":true,"reason":"still failing"}]`;
    });
    const verdict = await checkPreventStop(env);
    expect(verdict.block).toBe(true);
  });

  it('should accept a STALE hash that the lineage ring knows', async () => {
    // todo_update recomputes the hash; the model routinely holds the previous
    // one. `previousHashes` is exactly that history, so a stale-but-honest echo
    // must still gate the turn.
    const c = guarded({ id: 4, hash: 'current1', previousHashes: ['stale001'] });
    vi.mocked(forkChat).mockResolvedValue('[{"id":4,"hash":"stale001","hold":true,"reason":"r"}]');
    const verdict = await checkPreventStop(makeEnv([c]));
    expect(verdict.block).toBe(true);
  });

  it('should still reject a FABRICATED hash (anti-hallucination intact)', async () => {
    const c = guarded({ id: 4, hash: 'current1', previousHashes: ['stale001'] });
    vi.mocked(forkChat).mockResolvedValue('[{"id":4,"hash":"made-up","hold":true,"reason":"r"}]');
    const verdict = await checkPreventStop(makeEnv([c]));
    expect(verdict.block).toBe(false);
  });

  it('should report the TOPMOST guard in list order, not the reply order', async () => {
    const first = guarded({ id: 1, hash: 'h1', name: 'first' });
    const second = guarded({ id: 2, hash: 'h2', name: 'second' });
    vi.mocked(forkChat).mockResolvedValue(
      '[{"id":2,"hash":"h2","hold":true,"reason":"two"},{"id":1,"hash":"h1","hold":true,"reason":"one"}]',
    );
    const verdict = await checkPreventStop(makeEnv([first, second]));
    expect(verdict.note).toContain('#1');
  });
});

describe('parsePreventStopResult — balanced extraction (review 2026-10-24)', () => {
  it('should parse an array followed by bracketed prose', async () => {
    // Greedy /\[[\s\S]*\]/ spanned to the LAST bracket, JSON.parse threw, and the
    // guard silently failed open.
    const parsed = parsePreventStopResult('[{"id":1,"hash":"h","hold":true}]\nReasoning: [tests still fail]');
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].hold).toBe(true);
  });

  it('should ignore brackets inside JSON strings', () => {
    const spans = extractJsonArrayCandidates('[{"id":1,"reason":"see [2] and ]"}], trailing ]');
    expect(spans).toEqual(['[{"id":1,"reason":"see [2] and ]"}]']);
  });
});
