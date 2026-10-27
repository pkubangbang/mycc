import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  forkChat: (...args: unknown[]) => forkChatMock(...args),
}));

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => []) },
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
        brief: vi.fn(),
      },
    },
  } as unknown as MachineEnv;
}

/** Reply with a single verdict for `todo`, echoing its real hash. */
function reply(todo: Todo, id: number, held: boolean, reason?: string): void {
  const item = todo.getItems().find((i) => i.id === id)!;
  forkChatMock.mockResolvedValueOnce(
    JSON.stringify([{ id, hash: item.hash, held, ...(reason ? { reason } : {}) }]),
  );
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
    forkChatMock.mockResolvedValueOnce(JSON.stringify([
      { id: a.id, hash: todo.getItems()[0].hash, held: false },
      { id: b.id, hash: todo.getItems()[1].hash, held: false },
    ]));

    await checkPreventStop(env);

    expect(forkChatMock).toHaveBeenCalledTimes(1);
  });

  it('reports the TOPMOST (lowest id) held guard when several hold', async () => {
    const a = todo.createTodo('A');
    const b = todo.createTodo('B');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    todo.pinTodo(b.id, b.hash, true, 'gb');
    forkChatMock.mockResolvedValueOnce(JSON.stringify([
      { id: b.id, hash: todo.getItems()[1].hash, held: true, reason: 'b' },
      { id: a.id, hash: todo.getItems()[0].hash, held: true, reason: 'a' },
    ]));

    const r = await checkPreventStop(env);
    expect(r.guard?.id).toBe(a.id);
    expect(r.reason).toBe('a');
  });

  it('discards a verdict whose HASH does not match (hallucination)', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    forkChatMock.mockResolvedValueOnce(JSON.stringify([
      { id: a.id, hash: 'deadbeef', held: true, reason: 'fabricated' },
    ]));

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
    forkChatMock.mockResolvedValueOnce(JSON.stringify([
      { id: 'nope', hash: 'x', held: true },
      { id: a.id, hash: todo.getItems()[0].hash, held: true },
    ]));

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
    (env.ctx.core as unknown as { escAware: unknown }).escAware =
      async (_op: unknown, onCleanUp: () => string) => onCleanUp();
    forkChatMock.mockResolvedValueOnce('[]');

    expect((await checkPreventStop(env)).held).toBe(false);
  });

  it('never mutates the todo (releasing a guard is the agent\'s job)', async () => {
    const a = todo.createTodo('A');
    todo.pinTodo(a.id, a.hash, true, 'ga');
    const before = JSON.stringify(todo.getItems());
    reply(todo, a.id, true);

    await checkPreventStop(env);

    expect(JSON.stringify(todo.getItems())).toBe(before);
  });
});
