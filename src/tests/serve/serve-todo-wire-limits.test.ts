/**
 * serve-todo-wire-limits.test.ts — the wire limits that keep the panel sane.
 *
 * Three review NITs of commit b52ff0c, each of which fails SILENTLY in production:
 *
 *   1. MINOR-2 — `ServeHub.broadcastTodoList` must not re-send an unchanged list.
 *      Two producers push here (the async `todo_changed` listener and the sync
 *      resync); interleaved, they used to emit the same frame twice and `/history`
 *      could answer with the OLDER list for a tick — a visible panel flicker.
 *   2. `clampText` must slice CODE POINTS: `slice(0, 500)` can cut a surrogate pair,
 *      so a pinned-mark-class emoji at the boundary reached the panel as U+FFFD.
 *   3. `todoEtagToken` must stay INJECTIVE: the token is folded next to other
 *      `key:value` terms joined by `|`, so a todo name containing `|running:0`
 *      could collide with a different list — and a real change would 304 into a
 *      stale panel.
 */
import { describe, it, expect, vi } from 'vitest';
import { ServeHub, todoEtagToken } from '../../serve/serve-hub.js';
import { toTodoListPayload, type TodoListPayload } from '../../serve/serve-todos.js';

/** One wire row, minimal. */
function row(id: number, name = `todo ${id}`): TodoListPayload['todos'][number] {
  return { id, name, done: false, pinned: false };
}

describe('ServeHub.broadcastTodoList — dedupe at the sink', () => {
  /**
   * A stand-in with the REAL method on its prototype and only the two fields the
   * method touches. (`clients` is private on ServeHub, so an `Object.create` cast
   * collapses to `never` — this shape exercises the same code without a class cast.)
   */
  function makeHub() {
    const send = vi.fn();
    const HubLike = class {
      todoList: TodoListPayload | null = null;
      clients = { broadcastTodoList: send };
      broadcastTodoList = ServeHub.prototype.broadcastTodoList;
    } as unknown as new () => {
      todoList: TodoListPayload | null;
      clients: { broadcastTodoList: (p: TodoListPayload) => void };
      broadcastTodoList: (p: TodoListPayload) => void;
    };
    return { hub: new HubLike(), send };
  }

  it('sends the first snapshot', () => {
    const { hub, send } = makeHub();
    hub.broadcastTodoList({ type: 'todos', todos: [row(1)] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-send an identical list (interleaved producers)', () => {
    const { hub, send } = makeHub();
    const first: TodoListPayload = { type: 'todos', todos: [row(1), row(2)] };
    hub.broadcastTodoList(first);
    // A second producer pushes the SAME rows — typically the async listener racing
    // the synchronous resync.
    hub.broadcastTodoList({ type: 'todos', todos: [row(1), row(2)] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still sends when a row CHANGES (a rename of equal length included)', () => {
    const { hub, send } = makeHub();
    hub.broadcastTodoList({ type: 'todos', todos: [row(1, 'Task A')] });
    hub.broadcastTodoList({ type: 'todos', todos: [row(1, 'Task B')] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends when the list becomes empty', () => {
    const { hub, send } = makeHub();
    hub.broadcastTodoList({ type: 'todos', todos: [row(1)] });
    hub.broadcastTodoList({ type: 'todos', todos: [] });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('toTodoListPayload — the text budget cannot split a surrogate pair', () => {
  it('keeps a 500-code-point name intact and truncates beyond it on a pair boundary', () => {
    // 500 'a' then an emoji whose surrogate pair would straddle the limit.
    const name = 'a'.repeat(499) + '📌' + 'tail';
    const [entry] = toTodoListPayload([{ id: 1, name, done: false }]).todos;

    expect(entry.name.endsWith('…')).toBe(true);
    // The LAST character before the ellipsis must not be a lone high surrogate.
    const body = entry.name.slice(0, -1);
    expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false);
    expect([...body].length).toBeLessThanOrEqual(500);
  });

  it('leaves a name inside the budget untouched', () => {
    const name = 'short 📌 name';
    const [entry] = toTodoListPayload([{ id: 1, name, done: false }]).todos;
    expect(entry.name).toBe(name);
  });
});

describe('todoEtagToken — injective across the | join', () => {
  it('distinguishes two lists that would collide under naive concatenation', () => {
    const a: TodoListPayload = { type: 'todos', todos: [{ id: 1, name: 'x|running:0', done: false, pinned: false }] };
    const b: TodoListPayload = { type: 'todos', todos: [{ id: 1, name: 'x', done: false, pinned: false }] };
    expect(todoEtagToken(a)).not.toBe(todoEtagToken(b));
  });

  it('null has its own token, distinct from an empty list', () => {
    const empty: TodoListPayload = { type: 'todos', todos: [] };
    expect(todoEtagToken(null)).toBe('todo:null');
    expect(todoEtagToken(null)).not.toBe(todoEtagToken(empty));
  });

  it('is stable for identical content', () => {
    const a: TodoListPayload = { type: 'todos', todos: [row(1), row(2)] };
    const b: TodoListPayload = { type: 'todos', todos: [row(1), row(2)] };
    expect(todoEtagToken(a)).toBe(todoEtagToken(b));
  });
});
