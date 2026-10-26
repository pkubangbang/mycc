/**
 * history-todo-seed-apply.test.ts — the `/history` seed rule, on a real store.
 *
 * The rule used to live inline in `main.ts` (the browser entry, un-importable from
 * node), so it was deletable with the whole web suite green — and deleting it
 * reinstates the bug this feature exists to fix: every reload wipes the panel
 * (review m1 of commit b52ff0c).
 *
 * Each case fails if `applyHistoryTodos` regresses to one of the two shapes that
 * actually shipped: reading `undefined` through the parser (a silent wipe), or
 * treating `[]` as "keep" (a cleared session never clears).
 */
import { describe, it, expect } from 'vitest';
import { applyHistoryTodos } from '../../web/src/todo-payload';
import type { TodoListEntry } from '../../web/src/types';

const ROWS: TodoListEntry[] = [
  { id: 1, name: 'backfill authorId', done: false, pinned: false },
  { id: 2, name: 'wire the panel', done: true, pinned: true },
];

describe('applyHistoryTodos — the absent-vs-empty seed rule', () => {
  it('KEEPS the rows when the field is absent (the server does not speak this contract)', () => {
    const store = { todos: [...ROWS] };
    applyHistoryTodos(store, undefined);
    expect(store.todos.map((t) => t.id)).toEqual([1, 2]);
  });

  it('CLEARS on null (the server says "this session has no list yet")', () => {
    const store = { todos: [...ROWS] };
    applyHistoryTodos(store, null);
    expect(store.todos).toEqual([]);
  });

  it('CLEARS on the empty array (an authoritative empty list)', () => {
    const store = { todos: [...ROWS] };
    applyHistoryTodos(store, []);
    expect(store.todos).toEqual([]);
  });

  it('REPLACES on a bare array (the /history shape)', () => {
    const store = { todos: [] as TodoListEntry[] };
    applyHistoryTodos(store, [{ id: 7, name: 'fresh', done: false, pinned: false }]);
    expect(store.todos).toEqual([{ id: 7, name: 'fresh', done: false, pinned: false }]);
  });

  it('REPLACES on a {todos:[…]} wrapper (defends against the old wrapper bug)', () => {
    const store = { todos: [] as TodoListEntry[] };
    applyHistoryTodos(store, { type: 'todos', todos: ROWS });
    expect(store.todos.map((t) => t.id)).toEqual([1, 2]);
    expect(store.todos[1].pinned).toBe(true);
  });

  it('splices IN PLACE so the reactive array identity survives', () => {
    const store = { todos: [...ROWS] };
    const identity = store.todos;
    applyHistoryTodos(store, null);
    expect(store.todos).toBe(identity);
    expect(store.todos).toHaveLength(0);
  });

  it('DROPS rows that cannot be rendered instead of throwing', () => {
    const store = { todos: [] as TodoListEntry[] };
    applyHistoryTodos(store, [
      { id: 3, name: 'ok', done: false, pinned: false },
      { id: 'nope', name: 'bad id' } as unknown as TodoListEntry,
      { name: 'no id at all' } as unknown as TodoListEntry,
    ]);
    expect(store.todos.map((t) => t.id)).toEqual([3]);
  });
});
