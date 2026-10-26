/**
 * todo-payload.ts — the client half of the todo wire contract.
 *
 * Two transports carry the authoritative todo list:
 *   - a WebSocket `type: 'todos'` frame — `{type:'todos', todos: TodoListEntry[]}`
 *     (`TodoListPayload` on the server, src/serve/serve-todos.ts), pushed on
 *     every backend mutation;
 *   - the `todos` field of a `/history` 200 — a BARE `TodoListEntry[]`
 *     (or `null` when no mutation has been observed yet).
 *
 * The two shapes differ, and that difference is exactly where a real bug
 * lived: `main.ts` tested `Array.isArray(field)` while the server sent the
 * whole wrapper object, so every reload silently wiped the panel. This module
 * is the single place that normalises EITHER shape, so the two call sites
 * cannot drift apart again — and so the rule is unit-testable without a DOM.
 *
 * Both functions are tolerant of junk on purpose: a malformed frame must never
 * throw inside the message dispatcher (which would drop every later frame),
 * and must never erase a good panel.
 */
import type { TodoListEntry } from './types';

/**
 * Normalise whatever the server sent into a validated `TodoListEntry[]`.
 *
 * Accepts, in order:
 *   - a bare array (the `/history` shape),
 *   - a `{todos: [...]}` wrapper (the WS shape, or a server that sends the
 *     wrapper in `/history`),
 *   - anything else → `[]` (treated as "no list", i.e. clear).
 *
 * Entries that lack a numeric `id` or a string `name` are DROPPED rather than
 * rendered: `TodoCard` uses `id` as the v-for key and interpolates `name`, so
 * a `null` row would throw inside a computed and take the panel down. `done`
 * and `pinned` are coerced with `=== true` so a missing/!boolean field reads as
 * false instead of `undefined` leaking into a CSS class binding.
 *
 * Duplicate ids are collapsed (last wins): Vue rejects duplicate `:key`s, and
 * one id must mean one row — the whole point of the snapshot.
 */
export function parseTodoList(raw: unknown): TodoListEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { todos?: unknown }).todos)
      ? ((raw as { todos: unknown[] }).todos)
      : [];
  const byId = new Map<number, TodoListEntry>();
  for (const entry of list) {
    const normalised = normaliseEntry(entry);
    if (normalised) byId.set(normalised.id, normalised);
  }
  // Ascending id, matching the server's ordering, so a render never depends on
  // frame arrival order.
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Coerce one wire entry, or null when it cannot be rendered safely. */
export function normaliseEntry(raw: unknown): TodoListEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<TodoListEntry>;
  if (typeof e.id !== 'number' || !Number.isFinite(e.id)) return null;
  if (typeof e.name !== 'string') return null;
  const entry: TodoListEntry = {
    id: e.id,
    name: e.name,
    done: e.done === true,
    pinned: e.pinned === true,
  };
  if (typeof e.note === 'string' && e.note) entry.note = e.note;
  if (typeof e.preventStop === 'string' && e.preventStop) entry.preventStop = e.preventStop;
  return entry;
}

/**
 * Normalise a WS `todos` frame.
 *
 * Returns `null` when the frame carries no usable list — the caller must then
 * KEEP the current panel. This is deliberately different from `/history`
 * (where a missing field means "this session has no list yet" → clear): a live
 * frame is an incremental push, so an unusable one is a bug in that frame, not
 * evidence the list is empty.
 */
export function parseTodoFrame(raw: unknown): TodoListEntry[] | null {
  if (Array.isArray(raw)) return parseTodoList(raw);
  if (raw && typeof raw === 'object' && Array.isArray((raw as { todos?: unknown }).todos)) {
    return parseTodoList((raw as { todos: unknown[] }).todos);
  }
  return null;
}

/**
 * Apply the `todos` field of a `/history` 200 to the panel — the CLIENT half of the
 * seed contract, extracted so the rule has a callable identity.
 *
 * WHY EXTRACTED (review m1): this decision lived inline in `main.ts`, the browser
 * entry (createApp / window / a bootstrap IIFE), which no node test can import.
 * Deleting the guard therefore kept the ENTIRE web suite green — measured, not
 * assumed — while reinstating the very bug this feature exists to fix: every reload
 * wiped the panel. Same remedy as `session-reset.ts`.
 *
 * THE RULE — only a field that is PRESENT is authoritative:
 *   - `undefined` → the server does not speak this contract → KEEP the rows.
 *     `parseTodoList` collapses every unusable value to `[]`, and `[]` below means
 *     "replace the panel with nothing", so reading a missing key through it turns a
 *     protocol mismatch into a silent data wipe. (The server always emits the key —
 *     `historyTodosField` returns `null`, never `undefined` — so this branch is
 *     forward-compat, and it is exactly the branch a "simplify this" cleanup deletes.)
 *   - `null` / `[]` → "this session has no list" → clear (authoritative empty).
 *   - a bare array, or a `{todos:[…]}` wrapper → replace.
 *
 * In-place `splice`, never reassignment, so Pinia/Vue reactivity reaches the mounted
 * `TodoCard` and any array identity a watcher holds survives.
 */
export function applyHistoryTodos(
  store: { todos: TodoListEntry[] },
  field: unknown,
): void {
  if (field === undefined) return;
  store.todos.splice(0, store.todos.length, ...parseTodoList(field));
}
