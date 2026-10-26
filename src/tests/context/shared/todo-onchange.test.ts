/**
 * todo-onchange.test.ts - the `todo_changed` event on the loop event bus.
 *
 * The WebUI todo panel is fed by ONE subscription to `loopEvents`
 * (`serve-todos.ts` → `wireTodoSnapshot`). The EVENT is emitted from inside
 * every `TodoModule` mutation, which is what makes the channel impossible to
 * bypass: a new mutation path reaches the bus without anyone remembering to
 * emit.
 *
 * Why this file exists at all: the panel was originally fed by three explicit
 * `emitTodoList(...)` calls in todo_create / todo_update / todo_pinning — and
 * every OTHER mutation path drifted. `/clear`, `/todos clear`, the
 * double-Ctrl+L clear, the remote-peer reminder (`recordRemotePeerTodo`),
 * `tm_create`/`tm_remove` worktree todos and `hand_over` all changed the list invisibly.
 *
 * These tests pin "every mutation emits" plus the payload contract (one event
 * carrying the WHOLE list, with a `source` tag). They subscribe through the
 * public `loopEvents.on` API — the same surface the production subscriber uses,
 * so a regression in the emitter wiring fails here too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Todo } from '../../../context/shared/todo.js';
import { loopEvents, type TodoChangedPayload } from '../../../loop/loop-events.js';

/** Subscribe to `todo_changed` and collect every emitted payload. */
function capture(): { payloads: TodoChangedPayload[]; unsub: () => void } {
  const payloads: TodoChangedPayload[] = [];
  const unsub = loopEvents.on('todo_changed', (p) => payloads.push(p as TodoChangedPayload));
  return { payloads, unsub };
}

describe('Todo mutations emit `todo_changed` on loopEvents', () => {
  let captured: ReturnType<typeof capture>;

  beforeEach(() => {
    loopEvents.clear();
    captured = capture();
  });

  afterEach(() => {
    captured.unsub();
    loopEvents.clear();
  });

  it('fires on createTodo with the FULL resulting list and source=create', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    expect(captured.payloads).toHaveLength(1);
    expect(captured.payloads[0].source).toBe('create');
    expect(captured.payloads[0].items).toHaveLength(1);
    expect(captured.payloads[0].items[0].name).toBe('Task A');
  });

  it('fires on updateTodo with source=update', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    const b = todo.createTodo('Task B'); // keeps the list open, so no auto-clear
    captured.payloads.length = 0;
    todo.updateTodo(b.id, b.hash, 'Task B renamed', false);
    expect(captured.payloads).toHaveLength(1);
    expect(captured.payloads[0].source).toBe('update');
  });

  it('fires on updateTodo with source=autoclear when the edit purges the list', () => {
    // Review B6: an update that completes the LAST open non-pinned item also
    // auto-clears every non-pinned row. That is not an "update" to a subscriber —
    // the list it announces is empty — so it gets its own source, which is what
    // lets `todo_update` tell the model the row was purged rather than updated.
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    captured.payloads.length = 0;
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(captured.payloads).toHaveLength(1);
    expect(captured.payloads[0].source).toBe('autoclear');
    expect(captured.payloads[0].items).toHaveLength(0); // the purge is announced
  });

  it('fires on pinTodo with source=pin and carries the guard', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    captured.payloads.length = 0;
    todo.pinTodo(a.id, a.hash, true, 'until tests pass');
    expect(captured.payloads).toHaveLength(1);
    expect(captured.payloads[0].source).toBe('pin');
    expect(captured.payloads[0].items[0].pinned).toBe(true);
    expect(captured.payloads[0].items[0].preventStop).toBe('until tests pass');
  });

  it('fires on clear() with an EMPTY list and source=clear — the /clear regression', () => {
    // The original bug: clear() emptied the state but nothing emitted, so the
    // WebUI kept rendering rows for todos that no longer existed (and /clear
    // also wiped the log, so no corrective brief ever arrived).
    const todo = new Todo();
    todo.createTodo('Task A');
    todo.createTodo('Task B');
    captured.payloads.length = 0;
    todo.clear();
    expect(captured.payloads).toHaveLength(1);
    expect(captured.payloads[0].source).toBe('clear');
    expect(captured.payloads[0].items).toEqual([]);
  });

  it('does NOT fire when a mutation is rejected (no state change, no event)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    captured.payloads.length = 0;
    expect(todo.updateTodo(a.id, 'deadbeef', 'x', true)).toBeNull();
    expect(todo.updateTodo(999, 'deadbeef', 'x', true)).toBeNull();
    expect(captured.payloads).toHaveLength(0);
  });

  it('hands out COPIES, so a late mutation cannot rewrite an event already emitted', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    const first = captured.payloads[0].items;
    const extra = todo.createTodo('Task B');
    todo.updateTodo(extra.id, extra.hash, 'Task B', true);
    expect(first).toHaveLength(1); // still the state at emit time
  });

  it('the lineage ring is CLONED too — a shallow copy aliased the live array', () => {
    // The original `getItems()` spread each item (`{...i}`), which is SHALLOW:
    // `previousHashes` was the SAME array instance as the live item, so an
    // emitted payload kept GROWING as later updates pushed into the ring —
    // observed going ["h1"] → ["h1","h2"] after a subsequent updateTodo. The
    // payload contract says a listener may retain the items, so an alias that
    // mutates behind it is a broken promise, not a detail.
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, 'Task A (rev 2)', false); // ring gains a hash
    const emitted = captured.payloads[1].items[0] as unknown as { previousHashes?: string[] };
    const ringAtEmit = [...(emitted.previousHashes ?? [])];
    expect(ringAtEmit.length).toBeGreaterThan(0); // the ring is populated ...

    // ... and a LATER update must not reach into the already-emitted payload.
    todo.updateTodo(todo.getItems()[0].id, todo.getItems()[0].hash, 'Task A (rev 3)', false);
    expect(emitted.previousHashes).toEqual(ringAtEmit);
  });

  it('an ABSENT lineage ring stays absent (no empty array materialised)', () => {
    // `getItems()` clones the ring only when there is one. Materialising
    // `previousHashes: []` for every untouched item would change the payload
    // shape (`hash`/`previousHashes` are meant to be invisible) and bloat every
    // frame. The invariant is stated in `todo.ts`; this is what enforces it.
    const todo = new Todo();
    todo.createTodo('Task A'); // never updated => no ring at all
    const emitted = captured.payloads[0].items[0] as unknown as Record<string, unknown>;
    expect('previousHashes' in emitted).toBe(false);
    expect(emitted.previousHashes).toBeUndefined();
  });

  it('the emitted item is a copy — mutating it cannot corrupt the live list', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    const emitted = captured.payloads[0].items[0] as unknown as { name: string };
    emitted.name = 'HACKED';
    expect(todo.getItems()[0].name).toBe('Task A');
  });

  it('the unsubscribe handle detaches the listener', () => {
    const todo = new Todo();
    captured.unsub();
    todo.createTodo('Task A');
    expect(captured.payloads).toHaveLength(0);
  });

  it('supports MULTIPLE subscribers — the bus is not a single-slot callback', () => {
    const todo = new Todo();
    const second = capture();
    todo.createTodo('Task A');
    expect(captured.payloads).toHaveLength(1);
    expect(second.payloads).toHaveLength(1);
    second.unsub();
  });

  it('does not materialise the list when nobody listens (the O(n) guard)', () => {
    // `emitChanged` returns before `getItems()` when there are no listeners.
    // Removing that guard changes NO observable behaviour — every mutation
    // still works and still emits to real subscribers — which is exactly why a
    // behavioural test can never catch its loss, and why this lock observes the
    // allocation instead. It drives the REAL mutation and the REAL emitter; it
    // does not re-implement the guard.
    //
    // This test owns the bus: the describe-level `beforeEach` installs
    // `captured`, so "nobody listens" is unreachable while that subscription is
    // alive. Drop it, and restore it for the tests that follow.
    captured.unsub();
    loopEvents.clear();

    const todo = new Todo();
    const spy = vi.spyOn(todo, 'getItems');

    // No listeners: the list must NOT be built.
    todo.createTodo('Task A');
    expect(spy).not.toHaveBeenCalled();

    // A listener arrives: the list MUST be built, and the payload delivered.
    const sub = capture();
    todo.createTodo('Task B');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sub.payloads).toHaveLength(1);
    expect(sub.payloads[0].items).toHaveLength(2);
    sub.unsub();
    spy.mockRestore();

    // Leave the shared subscription as the other tests expect it.
    captured = capture();
  });

  it('a listener that UNSUBSCRIBES mid-dispatch cannot corrupt the iteration', () => {
    // `emit` iterates a COPY of the listener Set. Iterating the live Set while a
    // listener removes another one is the classic skip-a-listener bug. The
    // copy is not cosmetic, so it gets its own lock: removing it must turn this
    // red (the third listener would be skipped).
    const todo = new Todo();
    const seen: string[] = [];

    const first = loopEvents.on('todo_changed', () => {
      seen.push('A');
      third(); // remove C while B and C are still pending in this dispatch
    });
    loopEvents.on('todo_changed', () => seen.push('B'));
    const third = loopEvents.on('todo_changed', () => seen.push('C'));

    todo.createTodo('Task A');

    // A, B and C all ran for THIS dispatch: the removal of C affects the NEXT
    // emit, not the one already in flight.
    expect(seen).toEqual(['A', 'B', 'C']);

    // And the removal did take effect afterwards.
    seen.length = 0;
    todo.createTodo('Task B');
    expect(seen).toEqual(['A', 'B']);

    first();
    loopEvents.clear();
  });

  it('a throwing listener does not break the mutation and does not starve other listeners', () => {    // `emit()` isolates listeners per subscriber. Assert the PROPERTY rather
    // guarantee at the bus level. Assert the PROPERTY, not just consistency: a
    // bare `toHaveLength(1)` would pass whether or not isolation exists (the
    // mutation happens before the throw), so it could never catch a regression.
    const todo = new Todo();
    const bad = loopEvents.on('todo_changed', () => {
      throw new Error('listener exploded');
    });
    const after = capture(); // registered AFTER the thrower — must still run

    expect(() => todo.createTodo('Task A')).not.toThrow();

    expect(todo.getItems()).toHaveLength(1);   // the mutation committed
    expect(captured.payloads).toHaveLength(1); // the healthy listener ran
    expect(after.payloads).toHaveLength(1);    // the thrower did not abort the loop
    bad();
    after.unsub();
  });
});

describe('Todo ids are never reused (the panel keys rows by id)', () => {
  it('clear() does NOT reset nextId — a new item cannot collide with a stale row key', () => {
    loopEvents.clear();
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');
    todo.clear();
    const c = todo.createTodo('Task C');
    expect(c.id).toBeGreaterThan(b.id);
    expect(c.id).toBeGreaterThan(a.id);
    expect(c.id).not.toBe(a.id);
  });
});
