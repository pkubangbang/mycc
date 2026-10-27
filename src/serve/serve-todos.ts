/**
 * serve-todos.ts - the TODO LIST snapshot channel (backend side)
 *
 * The WebUI todo panel renders the AUTHORITATIVE todo list, not a replay of
 * `todo_*` briefs. This module is the single place that:
 *   - defines the wire shape ({@link TodoListEntry} / {@link TodoListPayload}),
 *   - builds that shape from the real `TodoModule` item list, and
 *   - pushes it to every connected browser as ONE `type: 'todos'` message.
 *
 * ## Why a snapshot, and why it is PUSHED on every mutation
 *
 * A todo tool mutates `TodoModule` state; the briefs it prints
 * (`Created #1: …` / `updated #1: …` / `pinned #1: …`) are an EVENT LOG. The
 * WebUI used to parse those briefs to guess the list, which meant one item
 * touched three times in a turn rendered three rows — the bug that motivated
 * this channel. A snapshot has exactly one row per todo id by construction.
 *
 * Pushing on every mutation (rather than folding the list into the brief)
 * keeps the two concerns apart: briefs stay human-facing one-liners for the
 * chat log, and the list is a separate, replaceable whole. A reconnect gets
 * the same list from `/history` (`todos` field), so the panel survives a
 * page refresh without replaying anything.
 *
 * ## One event, not N call sites
 *
 * The emit is driven by {@link wireTodoSnapshot}, which subscribes to the
 * `todo_changed` event on `loopEvents`. The REPO's event bus is used rather
 * than a bespoke callback so the channel has an event name, supports multiple
 * subscribers with unsubscribe handles, and is visible to the test harness
 * (`captureLoopEvents()`). Deliberately NOT emitted from each tool:
 * `TodoModule` is mutated from many places a tool-level emitter would miss —
 * `/clear`, `/todos clear`, the double-Ctrl+L clear, the remote-peer reminder
 * (`recordRemotePeerTodo`), `tm_create`/`tm_remove` worktree todos, and
 * `hand_over`. A per-call-site emit drifted out of sync with reality; emitting
 * inside the mutation itself cannot drift.
 *
 * ## Layering
 *
 * `loop → serve`, never the reverse (same invariant as `isWebUiUp()`): the
 * serve layer pulls itself in via `wireTodoSnapshot()` (called by
 * `wireServeCallbacks()`) and subscribes to the loop/bus; the loop/context
 * layer never imports this module. The hub import is dynamic so the loop layer
 * gains no static dependency on Express / Vite.
 *
 * ## Children (teammates)
 *
 * `TodoModule` is lead-only state (children keep their own, unrendered list),
 * and this listener is installed by the LEAD's serve wiring only, so a child's
 * todo change is never broadcast.
 */

import { loopEvents, type TodoChangedPayload } from '../loop/loop-events.js';

/** One row of the wire snapshot — a WHITELIST of what the panel draws. */
export interface TodoListEntry {
  /** Stable row key: the todo id. Unique for the whole session (ids are
   *  monotonic — `clear()` does not reset the counter). */
  id: number;
  name: string;
  done: boolean;
  /** Pinned = long-term reminder (📌 in the panel; survives auto-clear). */
  pinned: boolean;
  /** Natural-language stop guard, when the item carries one. */
  preventStop?: string;
  note?: string;
}

/** The full replacement snapshot sent as `type: 'todos'`. */
export interface TodoListPayload {
  type: 'todos';
  /** Complete current list, ascending by id. Empty array = nothing to show. */
  todos: TodoListEntry[];
}

/**
 * The subset of a todo row the panel DRAWS.
 *
 * Deliberately STRUCTURAL (not `TodoItem`): the input may arrive as a
 * `TodoItem` from `getItems()` or as the `todo_changed` event payload,
 * which is declared structurally in `loop-events.ts` so that module can stay
 * a zero-import leaf. Both satisfy this minimal shape, and the projection below
 * whitelists its fields anyway — an extra field on the input (`hash`,
 * `previousHashes`) is ignored by construction.
 */
export type TodoSnapshotItem = {
  id: number;
  name: string;
  done: boolean;
  pinned?: boolean;
  preventStop?: string;
  note?: string;
};

/** Per-entry text budget so one runaway item cannot bloat every frame. */
const MAX_TEXT_LEN = 500;

/** Clamp a free-form string (LLM-supplied tool args) to the wire budget. */
function clampText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > MAX_TEXT_LEN ? `${value.slice(0, MAX_TEXT_LEN)}…` : value;
}

/**
 * Project `TodoModule` items onto the wire shape.
 *
 * Pure and whitelist-based on purpose: the integrity `hash` and the
 * `previousHashes` lineage ring are LLM-facing anti-hallucination machinery,
 * not panel content, and shipping them would invite the UI to depend on them.
 * Free-form text (`name`/`note`/`preventStop`) is clamped: the full list is
 * re-serialized on every mutation, so an unbounded field would make the cost
 * quadratic in the number of items.
 */
export function toTodoListPayload(items: readonly TodoSnapshotItem[]): TodoListPayload {
  return {
    type: 'todos',
    todos: [...items]
      .sort((a, b) => a.id - b.id)
      .map((i) => {
        const entry: TodoListEntry = {
          id: i.id,
          name: clampText(i.name) ?? '',
          done: i.done === true,
          pinned: i.pinned === true,
        };
        // Omitted when falsy so the wire stays small and the client can treat
        // absent as "none" without a second convention.
        const note = clampText(i.note);
        if (note) entry.note = note;
        const preventStop = clampText(i.preventStop);
        if (preventStop) entry.preventStop = preventStop;
        return entry;
      }),
  };
}

/**
 * Subscribe the WebUI snapshot channel to the loop event bus.
 *
 * Call ONCE from the serve wiring (`wireServeCallbacks()`). Returns an
 * unsubscribe handle so a teardown can detach the listener rather than leaking
 * it.
 *
 * ## Why an event, not a bespoke callback
 *
 * An earlier design had a private single-slot observer on `TodoModule` instead
 * of a named event. The repo already owns an emitter for exactly this
 * (`loopEvents`): an import-free leaf whose `emit()` costs one `Map` lookup and
 * whose `captureLoopEvents()` harness subscribes to every type — making a todo
 * change observable in tests for free. The bus additionally supports several
 * subscribers with unsubscribe handles, which a single slot cannot.
 *
 * ## The late-subscriber problem (solved here, explicitly)
 *
 * `wireServeCallbacks()` runs at boot, BEFORE `activateServe()`. With `--serve`
 * that is fine: the listener attaches before any tool can mutate (a mutation
 * requires `machine.run()`, which starts after activateServe resolves). But
 * serve can also start MID-SESSION via `/serve`, attaching to a bus whose last
 * `todo_changed` has already fired — an emitter does not replay past events, so
 * the panel would sit empty (while terminal `/todos` showed rows) until the
 * next mutation.
 *
 * `seed` closes that without buffering per mutation. It is a pull, kept as ONE
 * retained reference (not a growing per-mutation queue) and invoked by
 * `resyncTodoSnapshot()` from the serve-start seam.
 *
 * ## Why the seed is NOT pushed from a registration hook
 *
 * The serve layer's registrations cannot carry this:
 *
 *   - `onServeHubReady` drains ONCE per process (`splice`), and
 *   - `onServeHubReRegistered` fires only from `registerServeHubFactory` — which
 *     `restartServe()` never calls, and which `ensureServeHub()` reaches only
 *     while `factory` is still unset.
 *
 * So on `--serve` boot the first push works, but a `stop()` → `/serve` RE-ENTRY
 * inside one process re-registers nothing: the hook never fires, the hub's
 * snapshot stays null, `/history` ships `todos: null`, and the client applies
 * that as an authoritative EMPTY list — wiping the panel while `TodoModule`
 * still holds rows.
 *
 * `activateServe()` is the only code that runs on the first start AND on every
 * re-entry, so it calls {@link resyncTodoSnapshot} after `hub.start()`. That
 * function compares against the hub's current snapshot SYNCHRONOUSLY, which also
 * makes a repeated call free of duplicate frames.
 */
export function wireTodoSnapshot(
  seed?: (() => readonly TodoSnapshotItem[]) | null,
): () => void {
  const unsubscribe = loopEvents.on('todo_changed', (payload) => {
    // Push the items the event already carries: they are copies taken inside
    // the mutation, so this is exactly the announced state.
    void broadcastNow((payload as TodoChangedPayload).items);
  });

  // Record the seed for the SERVE-START seam (`resyncTodoSnapshot`, called from
  // `activateServe()`). Do NOT also subscribe a registration hook here:
  //
  //   - `onServeHubReady` is one-shot per process, and
  //   - `onServeHubReRegistered` only fires from `registerServeHubFactory`,
  //     which `restartServe()` never calls and `ensureServeHub()` reaches only
  //     while `factory` is unset — so on a `stop()` → `/serve` RE-ENTRY in one
  //     process neither fires.
  //
  // Registering here as well caused a SECOND failure mode: `tryGetServeHub()`
  // binds `instance = factory()` before returning while the factory body itself
  // registers, so one boot fired the list twice — and because the push is async
  // the state comparison raced and both frames went out.
  //
  // `activateServe()` is the only code that runs on the first start AND on every
  // re-entry, so the trigger lives there and the comparison lives in
  // `resyncTodoSnapshot`, which is synchronous against the hub.
  installedSeed = seed ?? null;

  return unsubscribe;
}

/**
 * The seed registered by {@link wireTodoSnapshot}, if any.
 *
 * Kept at module scope so `activateServe()` — the ONE seam that runs on both the
 * first start and every `/serve` re-entry — can ask for a re-publish without the
 * serve layer importing the loop layer. Set once per process (the install site
 * calls `wireTodoSnapshot` exactly once).
 */
let installedSeed: (() => readonly TodoSnapshotItem[]) | null = null;

/**
 * Re-publish the current todo list to `hub`.
 *
 * Called by `activateServe()` after the server starts. It is a PULL (no
 * buffering, no queue), and it is SYNCHRONOUS with respect to the hub: it
 * compares against `hub.getTodoSnapshot()` and pushes directly, so calling it
 * twice in a row cannot emit two identical frames.
 *
 * A no-op when nothing installed a seed (a child process, or a caller that does
 * not render todos).
 */
export function resyncTodoSnapshot(hub: {
  getTodoSnapshot?: () => TodoListPayload | null;
  broadcastTodoList: (payload: TodoListPayload) => void;
}): void {
  try {
    if (!installedSeed) return;
    const wanted = toTodoListPayload(installedSeed());
    const current = typeof hub.getTodoSnapshot === 'function' ? hub.getTodoSnapshot() : null;
    // Same rows in the same order => the panel is already correct.
    if (current && JSON.stringify(current.todos) === JSON.stringify(wanted.todos)) return;
    hub.broadcastTodoList(wanted);
  } catch {
    /* a re-sync must never break serve startup */
  }
}
async function broadcastNow(items: readonly TodoSnapshotItem[]): Promise<void> {
  try {
    // Dynamic import: the todo/context layer must not statically depend on
    // the express/vite chain.
    const { tryGetServeHub } = await import('./serve-registry.js');
    tryGetServeHub()?.broadcastTodoList(toTodoListPayload(items));
  } catch {
    /* best-effort: a broadcasting failure must never break a todo mutation */
  }
}
