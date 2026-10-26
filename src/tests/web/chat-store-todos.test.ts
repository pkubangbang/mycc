/**
 * chat-store-todos.test.ts - the `todos` branch against the REAL Pinia store.
 *
 * Why a separate file: `message-dispatch-todos.test.ts` exercises
 * `applyServerMessage` against a HAND-ROLLED reactive stub, so it proves the
 * branch logic but NOT that the assignment works on the store the app actually
 * uses. A reviewer flagged exactly this gap: nothing drove
 * `applyServerMessage(useChatStore(), …)`, and `DispatchState.todos` being
 * optional is what kept the hole invisible.
 *
 * Pinia unwraps refs on the store proxy, so `state.todos = list` must write
 * through to the underlying `ref`. If that ever stopped holding (a Pinia
 * major, or someone converting the ref to a plain property), the panel would
 * silently freeze on its first frame and every stub-based test would still
 * pass. This file fails in that case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { applyServerMessage } from '../../web/src/message-dispatch.js';
import { useChatStore } from '../../web/src/stores/chat-store.js';
import type { ChatMessage, TodoListEntry } from '../../web/src/types.js';

/** The wire frame the backend emits. */
function todosFrame(todos: TodoListEntry[]): ChatMessage {
  return { type: 'todos', content: '', todos } as unknown as ChatMessage;
}

const row = (id: number, over: Partial<TodoListEntry> = {}): TodoListEntry => ({
  id, name: `todo ${id}`, done: false, pinned: false, ...over,
});

describe('applyServerMessage + the real Pinia chat store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('the store exposes `todos` (the panel\'s only data source)', () => {
    const store = useChatStore();
    expect(Array.isArray(store.todos)).toBe(true);
    expect(store.todos).toHaveLength(0);
  });

  it('a todos frame REPLACES store.todos through the Pinia proxy', () => {
    const store = useChatStore();
    const ctx = { nextId: () => 1, chatApi: { sendInput: vi.fn() } };
    applyServerMessage(store as never, todosFrame([row(1), row(2)]), ctx);
    expect(store.todos.map((t) => t.id)).toEqual([1, 2]);

    // Second frame replaces wholesale — one id, one row.
    applyServerMessage(store as never, todosFrame([row(2, { done: true })]), ctx);
    expect(store.todos).toHaveLength(1);
    expect(store.todos[0]).toMatchObject({ id: 2, done: true });
  });

  it('an empty frame clears the panel, and it does NOT touch the chat log', () => {
    const store = useChatStore();
    const ctx = { nextId: () => 1, chatApi: { sendInput: vi.fn() } };
    applyServerMessage(store as never, todosFrame([row(1)]), ctx);
    const messagesBefore = store.messages.length;

    applyServerMessage(store as never, todosFrame([]), ctx);
    expect(store.todos).toHaveLength(0);
    expect(store.messages.length).toBe(messagesBefore);
  });

  it('a todos frame does not disturb the phase', () => {
    const store = useChatStore();
    store.setPhase('prompt');
    const ctx = { nextId: () => 1, chatApi: { sendInput: vi.fn() } };
    applyServerMessage(store as never, todosFrame([row(3)]), ctx);
    expect(store.phase).toBe('prompt');
  });

  it('a malformed frame leaves store.todos untouched (keep the panel)', () => {
    const store = useChatStore();
    const ctx = { nextId: () => 1, chatApi: { sendInput: vi.fn() } };
    applyServerMessage(store as never, todosFrame([row(1)]), ctx);
    applyServerMessage(store as never, { type: 'todos', content: '' } as ChatMessage, ctx);
    expect(store.todos.map((t) => t.id)).toEqual([1]);
  });
});
