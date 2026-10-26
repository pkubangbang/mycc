/**
 * message-dispatch-todos.test.ts - the `type: 'todos'` frame on the client
 *
 * The WebUI todo panel renders the AUTHORITATIVE list, pushed by the backend
 * after every todo mutation. This pins the client half of that contract:
 *
 *  - a `todos` frame REPLACES the list wholesale (never merges or appends),
 *    so one todo id can never accumulate several rows;
 *  - it touches no chat-log state and no phase (the list is panel state, the
 *    `todo_*` briefs remain ordinary chat lines);
 *  - a malformed frame (no array) is ignored rather than wiping the panel.
 *
 * Regression context: the panel previously rebuilt the list by parsing
 * `todo_*` briefs, so `create #7` + `update #7` + `pin #7` in one turn drew
 * three rows for one item.
 */
import { describe, it, expect, vi } from 'vitest';
import { reactive, ref, computed } from 'vue';
import { applyServerMessage } from '../../web/src/message-dispatch.js';
import type { DispatchState } from '../../web/src/message-dispatch.js';
import type { ChatMessage, SteeringNote, TodoListEntry, WebuiPhase } from '../../web/src/types.js';

function makeState(): DispatchState {
  const phase = ref<WebuiPhase>('working');
  const isAutoMode = ref(false);
  const steeringBuffer = reactive<SteeringNote[]>([]);
  const pendingSteeringReview = reactive<SteeringNote[]>([]);
  const messages = reactive<ChatMessage[]>([]);
  const teammateMessages = reactive<ChatMessage[]>([]);
  const todos = reactive<TodoListEntry[]>([]);
  // The diagnostic tag the ChatInput state-row renders (detailed-logs mode only).
  const lastServerMsg = ref<{ type: string; at: number } | undefined>(undefined);

  return reactive({
    phase,
    isAutoMode,
    steeringBuffer,
    pendingSteeringReview,
    messages,
    teammateMessages,
    todos,
    lastServerMsg,
    showRetry: ref(false),
    isWaiting: computed(() => false),
    isRunning: computed(() => phase.value === 'working'),
    hasPendingCard: computed(() => false),
    hasReview: computed(() => pendingSteeringReview.length > 0),
    setPhase: (p: WebuiPhase) => { phase.value = p; },
    setAutoMode: (v: boolean) => { isAutoMode.value = v; },
  }) as unknown as DispatchState;
}

function makeCtx() {
  let id = 0;
  return { nextId: () => ++id, chatApi: { sendInput: vi.fn() } };
}

/** The wire frame the backend emits (serve-todos.ts TodoListPayload). */
function todosFrame(todos: TodoListEntry[]): ChatMessage {
  return { type: 'todos', content: '', todos } as unknown as ChatMessage;
}

function row(id: number, over: Partial<TodoListEntry> = {}): TodoListEntry {
  return { id, name: `todo ${id}`, done: false, pinned: false, ...over };
}

describe('applyServerMessage — todos snapshot', () => {
  it('stores the authoritative list, keyed by todo id', () => {
    const state = makeState();
    applyServerMessage(state, todosFrame([row(1), row(2, { done: true })]), makeCtx());

    expect(state.todos?.map((t) => t.id)).toEqual([1, 2]);
    expect(state.todos?.[1].done).toBe(true);
  });

  it('REPLACES the list — one id can never accumulate duplicate rows', () => {
    const state = makeState();
    // The buggy scenario's three briefs collapse into one snapshot row.
    applyServerMessage(state, todosFrame([row(7, { name: 'Sustained loop' })]), makeCtx());
    applyServerMessage(state, todosFrame([row(7, { name: 'Sustained loop', pinned: true })]), makeCtx());

    expect(state.todos).toHaveLength(1);
    expect(state.todos?.[0].pinned).toBe(true);
  });

  it('an empty snapshot clears the panel', () => {
    const state = makeState();
    applyServerMessage(state, todosFrame([row(1)]), makeCtx());
    applyServerMessage(state, todosFrame([]), makeCtx());
    expect(state.todos).toEqual([]);
  });

  it('does not touch the chat log or the phase', () => {
    const state = makeState();
    applyServerMessage(state, todosFrame([row(3)]), makeCtx());

    expect(state.messages).toHaveLength(0);
    expect(state.teammateMessages).toHaveLength(0);
    expect(state.phase).toBe('working');
  });

  it('ignores a malformed frame instead of wiping the panel', () => {
    const state = makeState();
    applyServerMessage(state, todosFrame([row(5)]), makeCtx());
    // No `todos` array at all.
    applyServerMessage(state, { type: 'todos', content: '' } as unknown as ChatMessage, makeCtx());

    expect(state.todos?.map((t) => t.id)).toEqual([5]);
  });
});

describe('applyServerMessage — a todos frame must not mask the phase-desync tag', () => {
  it('leaves lastServerMsg alone, so the tag still names the last phase-relevant frame', () => {
    const state = makeState();
    // A `running` frame is the kind the diagnostic exists for...
    applyServerMessage(state, { type: 'running', content: 'off' } as unknown as ChatMessage, makeCtx());
    const afterRunning = state.lastServerMsg?.type;
    // ...and a todo mutation must not hide it (todos fires on EVERY todo change).
    applyServerMessage(state, todosFrame([row(1)]), makeCtx());
    expect(state.lastServerMsg?.type).toBe(afterRunning);
    expect(state.lastServerMsg?.type).not.toBe('todos');
  });
});
