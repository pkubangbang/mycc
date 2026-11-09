import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * STOP-guard gate tests: `checkPreventStop()` and its escalation in STOP.
 *
 * The gate is a forkChat boundary, so forkChat and the loader are mocked; the
 * todo store is the REAL `Todo` class so the id+hash verification runs against
 * live items (a stub would let a wrong hash pass and hide the
 * anti-hallucination property this gate depends on).
 */

const forkChatMock = vi.fn();
vi.mock('../../../engine/chat-provider.js', () => ({
  forkChat: (...args: unknown[]) => forkChatMock(...args)
}));

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => []) }
}));

// The guard fork now owns a caller-side spinner pair. Unmocked, the real
// module would start an 80ms interval writing cursor escapes into the test
// process's stdout. Mocking it also pins the ownership contract.
const startSpinnerMock = vi.fn();
const stopSpinnerMock = vi.fn();
vi.mock('../../../engine/chat-helpers.js', () => ({
  startSpinner: (...args: unknown[]) => startSpinnerMock(...args),
  stopSpinner: (...args: unknown[]) => stopSpinnerMock(...args)
}));

import { checkPreventStop } from '../../../loop/states/stop-prevent-stop.js';
import { Todo } from '../../../context/shared/todo.js';
import type { MachineEnv } from '../../../loop/state-machine.js';

/** Minimal MachineEnv: real Todo + a fake triologue/ctx surface. */
function makeEnv(todo: Todo): MachineEnv {
  return {
    scope: 'main',
    triologue: { getMessages: () => [] },
    ctx: {
      todo,
      core: {
        escAware: async (op: (ac: AbortController) => Promise<string>) => op(new AbortController()),
        verbose: vi.fn(),
        brief: vi.fn()
      }
    }
  } as unknown as MachineEnv;
}

/** Reply with a single verdict for `todo`, echoing its real hash. */
function reply(todo: Todo, id: number, held: boolean, reason?: string): void {
  const item = todo.getItems().find((i) => i.id === id)!;
  forkChatMock.mockResolvedValueOnce(JSON.stringify([{ id, hash: item.hash, held, ...(reason ? { reason } : {}) }]));
}

describe('checkPreventStop', () => {
  let todo: Todo;
  let env: MachineEnv;

  beforeEach(() => {
    todo = new Todo();
    env = makeEnv(todo);
    forkChatMock.mockReset();
  });

  it('does nothing (no LLM call) when no todo carries a guard', async () => {
    todo.createTodo('plain task');
    const r = await checkPreventStop(env);
    expect(r.held).toBe(false);
    expect(forkChatMock).not.toHaveBeenCalled();
  });

  it('ignores a guard on a non-pinned todo', async () => {
    const a = todo.createTodo('unpinned');
    todo.pinTodo(a.id, a.hash, false, 'should be cleared');
    const r = await checkPreventStop(env);
    expect(r.held).toBe(false);
    expect(forkChatMock).not.toHaveBeenCalled();
  });

  it('HELDS the turn and reports the guard when the evaluator says held', async () => {
    const a = todo.createTodo('Fix the flaky test');
    todo.pinTodo(a.id, a.hash, true, 'the test passes');
    reply(todo, a.id, true, 'the test still fails');

    const r = await checkPreventStop(env);

    expect(r.held).toBe(true);
    expect(r.guard).toEqual({ id: a.id, name: 'Fix the flaky test', condition: 'the test passes' });
    expect(r.reason).toBe('the test still fails');
  });

  it('allows the stop when the evaluator says not held', async () => {
    const a = todo.createTodo('Fix the flaky test');
    todo.pinTodo(a.id, a.hash, true, 'the test passes');
    reply(todo, a.id, false);

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it('batches ALL guards into ONE call', async () => {
    const a = todo.createTodo('A');
    const b = todo.createTodo('B');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    todo.pinTodo(b.id, b.hash, true, 'gb');
    forkChatMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: a.id, hash: todo.getItems()[0].hash, held: false },
        { id: b.id, hash: todo.getItems()[1].hash, held: false }
      ])
    );

    await checkPreventStop(env);

    expect(forkChatMock).toHaveBeenCalledTimes(1);
  });

  it('reports the TOPMOST (lowest id) held guard when several hold', async () => {
    const a = todo.createTodo('A');
    const b = todo.createTodo('B');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    todo.pinTodo(b.id, b.hash, true, 'gb');
    forkChatMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: b.id, hash: todo.getItems()[1].hash, held: true, reason: 'b' },
        { id: a.id, hash: todo.getItems()[0].hash, held: true, reason: 'a' }
      ])
    );

    const r = await checkPreventStop(env);
    expect(r.guard?.id).toBe(a.id);
    expect(r.reason).toBe('a');
  });

  it('discards a verdict whose HASH does not match (hallucination)', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    forkChatMock.mockResolvedValueOnce(
      JSON.stringify([{ id: a.id, hash: 'deadbeef', held: true, reason: 'fabricated' }])
    );

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it('discards a verdict for an unknown id', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    forkChatMock.mockResolvedValueOnce(JSON.stringify([{ id: 999, hash: 'x', held: true }]));

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it('skips malformed entries but honours a valid sibling', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    forkChatMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: 'nope', hash: 'x', held: true },
        { id: a.id, hash: todo.getItems()[0].hash, held: true }
      ])
    );

    expect((await checkPreventStop(env)).held).toBe(true);
  });

  it('FAILS OPEN when forkChat throws', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    forkChatMock.mockRejectedValueOnce(new Error('endpoint down'));

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it('FAILS OPEN on non-JSON output', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    forkChatMock.mockResolvedValueOnce('the guard is HELD, trust me');

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it('FAILS OPEN when ESC aborts the fork (escAware clean-up path)', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    // Simulate the escAware clean-up branch: the operation never resolves to
    // text, the wrapper returns ''.
    (env.ctx.core as unknown as { escAware: unknown }).escAware = async (_op: unknown, onCleanUp: () => string) =>
      onCleanUp();
    forkChatMock.mockResolvedValueOnce('[]');

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it("never mutates the todo (releasing a guard is the agent's job)", async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    const before = JSON.stringify(todo.getItems());
    reply(todo, a.id, true);

    await checkPreventStop(env);

    expect(JSON.stringify(todo.getItems())).toBe(before);
  });

  it('PAINTS the wait: one spinner pair around the guard fork, start → fork → stop', async () => {
    const a = todo.createTodo('guarded');
    todo.pinTodo(a.id, a.hash, true, 'condition met');
    reply(todo, a.id, true);
    startSpinnerMock.mockClear();
    stopSpinnerMock.mockClear();

    await checkPreventStop(env);

    // forkChat is permanently noSpinner and retryChat stopped its own spinner
    // before STOP, so the guard was judged against a completely blank terminal.
    // A held guard deliberately does not return to the prompt, so a silent wait
    // here reads as a hang.
    expect(startSpinnerMock).toHaveBeenCalledTimes(1);
    expect(stopSpinnerMock).toHaveBeenCalledTimes(1);
    const startedAt = startSpinnerMock.mock.invocationCallOrder[0];
    const forkedAt = forkChatMock.mock.invocationCallOrder[0];
    const stoppedAt = stopSpinnerMock.mock.invocationCallOrder[0];
    expect(startedAt).toBeLessThan(forkedAt);
    expect(forkedAt).toBeLessThan(stoppedAt);
  });

  it('stops the spinner on a FAILING fork (no leaked line at STOP)', async () => {
    const a = todo.createTodo('guarded');
    todo.pinTodo(a.id, a.hash, true, 'condition met');
    forkChatMock.mockRejectedValueOnce(new Error('provider down'));
    startSpinnerMock.mockClear();
    stopSpinnerMock.mockClear();

    expect((await checkPreventStop(env)).held).toBe(false); // fail-open
    expect(startSpinnerMock).toHaveBeenCalledTimes(1);
    expect(stopSpinnerMock).toHaveBeenCalledTimes(1);
  });

  it('spends NO spinner when there is nothing to judge', async () => {
    todo.createTodo('plain task');
    startSpinnerMock.mockClear();
    stopSpinnerMock.mockClear();

    await checkPreventStop(env);

    expect(startSpinnerMock).not.toHaveBeenCalled();
    expect(stopSpinnerMock).not.toHaveBeenCalled();
  });

  it('runs the guard fork on the tight budget, not the loop defaults', async () => {
    const a = todo.createTodo('guarded');
    todo.pinTodo(a.id, a.hash, true, 'condition met');
    reply(todo, a.id, true);

    await checkPreventStop(env);

    // Minutes of held STOP on a hung endpoint would be indistinguishable from
    // a dead process, and every failure path is fail-open anyway.
    const cfg = forkChatMock.mock.calls[0][5] as Record<string, number>;
    expect(cfg).toBeDefined();
    expect(cfg.firstTokenTimeoutMs).toBeLessThanOrEqual(10_000);
    expect(cfg.responseTimeoutMs).toBeLessThanOrEqual(30_000);
    expect(cfg.maxRetries).toBeLessThanOrEqual(1);
  });
});

describe('checkPreventStop — STALL PREVENTION (ending classification)', () => {
  let todo: Todo;
  let env: MachineEnv;

  /** Reply with a single verdict carrying an `ending` classification. */
  function replyEnding(
    t: Todo,
    id: number,
    held: boolean,
    ending?: 'complete' | 'blocked' | 'question',
    reason?: string
  ): void {
    const item = t.getItems().find((i) => i.id === id)!;
    forkChatMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          id,
          hash: item.hash,
          held,
          ...(ending ? { ending } : {}),
          ...(reason ? { reason } : {})
        }
      ])
    );
  }

  beforeEach(() => {
    todo = new Todo();
    env = makeEnv(todo);
    forkChatMock.mockReset();
  });

  it('STALLS: question-ending with the goal unmet holds the turn (stall:true)', async () => {
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated and tests pass');
    // Evaluator cannot affirm the goal met (held:true) AND the final message
    // is a backward-ask → this is the stall the feature exists to prevent.
    replyEnding(todo, a.id, true, 'question', 'asked which migration to run');

    const r = await checkPreventStop(env);
    expect(r.held).toBe(true);
    expect(r.stall).toBe(true);
    expect(r.guard?.id).toBe(a.id);
  });

  it('STALLS when the goal is not verifiably met and the ending is a question', async () => {
    // The critical regression case: a question-ending must not slip through
    // when the goal is unmet. held:true (not verifiably met) + question → stall.
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated');
    replyEnding(todo, a.id, true, 'question');
    expect((await checkPreventStop(env)).stall).toBe(true);
  });

  it('ALLOWS the stop: question-ending WITH the goal verifiably met (held:false)', async () => {
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated');
    // Goal met (held:false) → a trailing question is fine; no stall.
    replyEnding(todo, a.id, false, 'question');

    const r = await checkPreventStop(env);
    expect(r.held).toBe(false);
    expect(r.stall).toBeUndefined();
  });

  it('ALLOWS the stop: blocked-ending (hard blocker) is a legitimate stop even with the goal unmet', async () => {
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated');
    // Goal unmet (held:true) but the agent declared a HARD blocker → the turn
    // MUST be allowed to end: 'blocked' short-circuits and overrides held.
    replyEnding(todo, a.id, true, 'blocked', 'need the production DB password');

    const r = await checkPreventStop(env);
    // held:false (stop allowed), no stall — the gate does not deflect a real blocker.
    expect(r.held).toBe(false);
    expect(r.stall).toBeUndefined();
  });

  it('a blocked guard does not release OTHER guards that still hold', async () => {
    const a = todo.createTodo('Blocked task');
    const b = todo.createTodo('Unfinished task');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    todo.pinTodo(b.id, b.hash, true, 'gb');
    const items = todo.getItems();
    // a declares a hard blocker (allowed to stop); b is goal-unmet + complete
    // (still holds). The blocked verdict must not mask b's hold.
    forkChatMock.mockResolvedValueOnce(
      JSON.stringify([
        { id: a.id, hash: items[0].hash, held: true, ending: 'blocked' },
        { id: b.id, hash: items[1].hash, held: true, ending: 'complete' }
      ])
    );

    const r = await checkPreventStop(env);
    expect(r.held).toBe(true);
    expect(r.guard?.id).toBe(b.id); // b is the one reported, not the blocked a
    expect(r.stall).toBeUndefined();
  });

  it('complete-ending with the goal unmet is a plain goal-unmet hold (no stall)', async () => {
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated');
    replyEnding(todo, a.id, true, 'complete');

    const r = await checkPreventStop(env);
    expect(r.held).toBe(true);
    expect(r.stall).toBeUndefined();
  });

  it('FAILS OPEN to legacy held-only behavior when `ending` is absent', async () => {
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated');
    // No `ending` field (older model / unparseable) → fall back to `held`.
    replyEnding(todo, a.id, false, undefined);

    const r = await checkPreventStop(env);
    expect(r.held).toBe(false);
    expect(r.stall).toBeUndefined();
  });

  it('FAILS OPEN when `ending` is an unexpected value (not one of the three)', async () => {
    const a = todo.createTodo('Migrate the schema');
    todo.pinTodo(a.id, a.hash, true, 'schema is migrated');
    const item = todo.getItems()[0];
    forkChatMock.mockResolvedValueOnce(JSON.stringify([{ id: a.id, hash: item.hash, held: false, ending: 'maybe' }]));

    const r = await checkPreventStop(env);
    expect(r.held).toBe(false);
    expect(r.stall).toBeUndefined();
  });
});
