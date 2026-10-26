/**
 * serve-todos.test.ts - the authoritative TODO LIST snapshot channel
 *
 * Regression lock for the WebUI todo panel bug: the panel used to derive its
 * rows by parsing `todo_*` briefs, which are EVENTS — creating, updating and
 * pinning one item inside a single turn produced three briefs and therefore
 * three rows for one todo. The fix is a snapshot: one entry per todo id,
 * built from `TodoModule.getItems()` and pushed as ONE `type: 'todos'` frame.
 *
 * These tests pin the SNAPSHOT contract (shape, ordering, whitelist) and the
 * one-row-per-id invariant that the event-derived rendering could not hold.
 */
import { describe, it, expect } from 'vitest';
import { toTodoListPayload } from '../../serve/serve-todos.js';
import { historyTodosField } from '../../serve/serve-hub.js';
import type { TodoItem } from '../../types.js';

/** A todo item as TodoModule holds it (hash/lineage are LLM-facing only). */
function item(over: Partial<TodoItem> & { id: number }): TodoItem {
  return { name: `todo ${over.id}`, done: false, hash: 'deadbeef', ...over };
}

describe('toTodoListPayload', () => {
  it('emits one entry per todo id — the invariant the brief-derived panel broke', () => {
    // The exact scenario from the bug: ONE item created, updated, then pinned.
    // Three briefs fired; the snapshot must still be a single row.
    const payload = toTodoListPayload([
      item({ id: 7, name: 'Sustained code-quality loop', pinned: true }),
    ]);
    expect(payload.type).toBe('todos');
    expect(payload.todos).toHaveLength(1);
    expect(payload.todos[0].id).toBe(7);
  });

  it('sorts ascending by id regardless of input order', () => {
    const payload = toTodoListPayload([item({ id: 3 }), item({ id: 1 }), item({ id: 2 })]);
    expect(payload.todos.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('carries the panel fields and WHITELISTS the LLM-facing ones', () => {
    const payload = toTodoListPayload([
      item({ id: 1, name: 'n', done: true, note: 'a note', pinned: true, preventStop: 'until done' }),
    ]);
    const row = payload.todos[0];
    expect(row).toEqual({
      id: 1,
      name: 'n',
      done: true,
      pinned: true,
      note: 'a note',
      preventStop: 'until done',
    });
    // The integrity hash and the lineage ring are anti-hallucination machinery
    // for the LLM, not panel content — shipping them would invite the UI to
    // depend on them.
    expect(row).not.toHaveProperty('hash');
    expect(row).not.toHaveProperty('previousHashes');
  });

  it('omits falsy optional fields instead of sending empty strings', () => {
    const row = toTodoListPayload([item({ id: 2, note: '', preventStop: '' })]).todos[0];
    expect(row).not.toHaveProperty('note');
    expect(row).not.toHaveProperty('preventStop');
  });

  it('treats missing pinned/done as false (never undefined on the wire)', () => {
    const row = toTodoListPayload([{ id: 9, name: 'bare', done: false }]).todos[0];
    expect(row.done).toBe(false);
    expect(row.pinned).toBe(false);
  });

  it('IGNORES extra fields on the input (hash/lineage never reach the wire)', () => {
    // The projection is structural now, so a full TodoItem (with `hash` and
    // `previousHashes`) may be passed; the whitelist must still drop them.
    const withExtras = { id: 4, name: 'x', done: false, hash: 'deadbeef', previousHashes: ['a', 'b'] };
    const row = toTodoListPayload([withExtras as never]).todos[0];
    expect(row).not.toHaveProperty('hash');
    expect(row).not.toHaveProperty('previousHashes');
  });

  it('an empty list is a valid, non-null snapshot (clears the panel)', () => {
    expect(toTodoListPayload([])).toEqual({ type: 'todos', todos: [] });
  });

  it('does not alias the source array (a later mutation cannot alter a sent frame)', () => {
    const source = [item({ id: 1 })];
    const payload = toTodoListPayload(source);
    source.push(item({ id: 2 }));
    expect(payload.todos).toHaveLength(1);
  });
});

describe('/history seed shape — the contract that used to break the panel', () => {
  /**
   * `GET /history` ships `todos: historyTodosField(this.todoList)` — the BARE
   * entry array, NOT the `{type:'todos', todos:[…]}` wrapper that the WS frame
   * carries. The client's `Array.isArray(field)` check silently rejected the
   * wrapper, so every reload wiped the panel.
   *
   * ⚠ These assertions call the REAL handler helper (`historyTodosField`).
   * An earlier version defined a local `seedFrom` that re-implemented the
   * expression — so it passed even after the bug was reintroduced. Do not
   * reintroduce that pattern.
   */
  it('the seed is a BARE array — never the {type,todos} wrapper', () => {
    const seed = historyTodosField(toTodoListPayload([item({ id: 1, name: 'a' })]));
    expect(Array.isArray(seed)).toBe(true);
    expect(seed).not.toHaveProperty('type');
    expect(seed).not.toHaveProperty('todos');
    // The wrapper is what a WS frame sends — assert the two differ, which is
    // precisely the mistake that shipped.
    const frame = toTodoListPayload([item({ id: 1, name: 'a' })]);
    expect(Array.isArray(frame)).toBe(false);
    expect(frame.todos).toEqual(seed);
  });

  it('a WS frame body and the /history seed are NOT interchangeable', () => {
    // The regression in one line: feeding the FRAME where the SEED is expected
    // must not look like a valid list to the client's Array.isArray check.
    const frame = toTodoListPayload([item({ id: 1 })]);
    expect(Array.isArray(frame)).toBe(false);
    expect(Array.isArray(historyTodosField(null))).toBe(false); // null is not a list
  });

  it('null (no mutation observed yet) seeds null, which the client reads as "clear"', () => {
    expect(historyTodosField(null)).toBeNull();
  });

  it('a populated list round-trips through the client normaliser', async () => {
    // Cross-check against the real client-side parser rather than a shape
    // guess: the server seed must survive parseTodoList unchanged.
    const { parseTodoList } = await import('../../web/src/todo-payload.js');
    const seed = historyTodosField(
      toTodoListPayload([item({ id: 3, name: 'c', done: true, pinned: true, note: 'n' })]),
    );
    const rows = parseTodoList(seed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 3, name: 'c', done: true, pinned: true, note: 'n' });
  });
});
