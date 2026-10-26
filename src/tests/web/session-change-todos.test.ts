/**
 * session-change-todos.test.ts - the SESSION-ISOLATION rule must cover todos.
 *
 * When the server's sessionId changes (a serve restart started a new session),
 * `fetchConfig()` clears the store: chat arrays, teammate messages AND the todo
 * panel. Leaving `todos` populated showed the previous session's checklist
 * until /history returned — and indefinitely while /history kept failing,
 * because the WS only connects after a successful history fetch, so no
 * corrective `todos` frame could ever arrive.
 *
 * ⚠ THIS FILE MUST CALL THE PRODUCTION FUNCTION. An earlier version of this
 * test re-performed `store.todos.splice(...)` on a store it had just populated;
 * a reviewer deleted the real call from `main.ts` and the whole web suite
 * stayed 150/150 green. The clear now lives in `session-reset.ts` precisely so
 * it is importable here: deleting the `store.todos` line from
 * `resetSessionState` makes these tests fail.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from '../../web/src/stores/chat-store.js';
import { resetSessionState } from '../../web/src/session-reset.js';
import type { TodoListEntry } from '../../web/src/types.js';

const row = (id: number): TodoListEntry => ({ id, name: `todo ${id}`, done: false, pinned: false });

describe('resetSessionState — a session change empties the todo panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('clears todos along with both chat arrays (the whole rule)', () => {
    const store = useChatStore();
    store.todos.push(row(1), row(2));
    store.messages.push({ type: 'log', content: 'old session', id: 1 });
    store.teammateMessages.push({ type: 'log', content: 'old teammate', id: 2, label: '@t/x' });

    resetSessionState(store);

    expect(store.todos).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    expect(store.teammateMessages).toHaveLength(0);
  });

  it('does NOT silently skip todos — the regression that stayed green', () => {
    // Deleting the todos line from resetSessionState leaves this red.
    const store = useChatStore();
    store.todos.push(row(9));
    resetSessionState(store);
    expect(store.todos).toHaveLength(0);
  });

  it('splices in place, so a subscriber observes the empty list (Pinia reactivity)', () => {
    // Reassignment would satisfy a bare length check but not Vue reactivity.
    const store = useChatStore();
    store.todos.push(row(7));
    const identityBefore = store.todos;
    resetSessionState(store);
    expect(store.todos).toBe(identityBefore); // same array object, emptied
    expect(store.todos.length).toBe(0);
  });

  it('is idempotent and safe on an already-empty store', () => {
    const store = useChatStore();
    expect(() => resetSessionState(store)).not.toThrow();
    expect(() => resetSessionState(store)).not.toThrow();
    expect(store.todos).toHaveLength(0);
  });

  it('works on any structural store, not just Pinia (the helper has no store dependency)', () => {
    const plain = { messages: [{ type: 'log', content: 'a' }], teammateMessages: [], todos: [row(1)] };
    resetSessionState(plain as never);
    expect(plain.todos).toHaveLength(0);
    expect(plain.messages).toHaveLength(0);
  });
});
