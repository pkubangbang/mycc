/**
 * wire-todo-snapshot.test.ts - the serve-side todo snapshot channel.
 *
 * Two contracts live here:
 *
 * 1. **The bus is the only input for mutations.** `wireTodoSnapshot()` attaches
 *    ONE listener to `loopEvents`; a mutation therefore reaches the broadcaster
 *    without any tool-level emit. (An earlier round tried per-tool emits and
 *    drifted: `/clear`, `/todos clear`, the double-Ctrl+L clear,
 *    `recordRemotePeerTodo`, `tm_create`/`tm_remove` and `hand_over` all mutated
 *    the list invisibly.)
 *
 * 2. **The snapshot is re-published from the SERVE-START seam.** This is the
 *    part that took three review rounds to get right, so read carefully.
 *
 * ## Why the seed is NOT a registration hook
 *
 * Earlier versions hung the seed off `onServeHubReady` and then off a bespoke
 * `onServeHubReRegistered`. Both failed, for reasons that are properties of the
 * registry, not of this module:
 *
 *   - `onServeHubReady` drains ONCE per process (`splice`), and
 *     `ensureServeHub()` short-circuits on `if (!factory)`.
 *   - `registerServeHubFactory` has exactly two callers: `ServeHub`'s
 *     constructor (once per process) and `ensureServeHub` (only while `factory`
 *     is unset). `restartServe()` calls neither.
 *
 * So a `stop()` → `/serve` RE-ENTRY inside one process re-registers NOTHING: no
 * hook fires, the hub's snapshot stays null, `/history` ships `todos: null`, and
 * the client applies that as an authoritative EMPTY list — wiping the panel
 * while `TodoModule` still holds rows. A previous version of THIS FILE locked
 * that hook by calling `registerServeHubFactory` twice, a path production never
 * takes; it stayed green while the real defect shipped.
 *
 * `activateServe()` is the only code that runs on the first start AND on every
 * re-entry, so it calls `resyncTodoSnapshot(hub)` after `hub.start()`. That is
 * what these tests drive.
 *
 * ## Why the comparison is synchronous
 *
 * The push must not be async: an earlier attempt compared against
 * `hub.getTodoSnapshot()` inside an `await`ing helper, so on boot both of the
 * day's two triggers read `null` before either frame landed and TWO identical
 * frames went out. `resyncTodoSnapshot` compares and broadcasts synchronously
 * against the hub it is handed, which makes a repeated call a true no-op.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { TodoSnapshotItem, TodoListPayload } from '../../serve/serve-todos.js';
import type { loopEvents as LoopEventsSingleton, TodoChangedPayload } from '../../loop/loop-events.js';
import type { ServeHubLike } from '../../serve/serve-registry.js';

const item = (id: number, over: Partial<TodoSnapshotItem> = {}): TodoSnapshotItem => ({
  id, name: `todo ${id}`, done: false, pinned: false, ...over,
});

type Push = { pushed: TodoListPayload[]; hub: ServeHubLike };

/**
 * A minimally structural hub stub — `broadcastTodoList` is exercised by the bus
 * tests. Cast at the boundary rather than faking the whole ServeHub interface.
 */
function makeRecordingHub(): Push {
  const pushed: TodoListPayload[] = [];
  const hub = {
    broadcastTodoList: (p: TodoListPayload) => { pushed.push(p); },
  } as unknown as ServeHubLike;
  return { pushed, hub };
}

/**
 * A hub that also carries a snapshot, for the re-sync tests. `getTodoSnapshot`
 * is what makes the push idempotent.
 */
function hubWith(snapshot: TodoListPayload | null) {
  const pushed: TodoListPayload[] = [];
  const hub = {
    getTodoSnapshot: () => snapshot,
    broadcastTodoList: (p: TodoListPayload) => { pushed.push(p); },
  };
  return { pushed, hub };
}

type Setup = {
  /** The SAME `loopEvents` instance the SUT's `wireTodoSnapshot` subscribes to. */
  loopEvents: typeof LoopEventsSingleton;
  wireTodoSnapshot: (seed?: (() => readonly TodoSnapshotItem[]) | null) => () => void;
  resyncTodoSnapshot: typeof import('../../serve/serve-todos.js')['resyncTodoSnapshot'];
  reg: typeof import('../../serve/serve-registry.js');
};

const detachers: Array<() => void> = [];

/**
 * Reset the module graph and hand back a CONSISTENT (bus, SUT, registry) set.
 * Order is load-bearing: reset first, import after — `serve-todos` holds a
 * STATIC binding to the registry, so resetting AFTER the import would give the
 * test a registry the SUT never talks to.
 */
async function setup(): Promise<Setup> {
  vi.resetModules();
  const events = await import('../../loop/loop-events.js');
  const todos = await import('../../serve/serve-todos.js');
  const reg = await import('../../serve/serve-registry.js');

  const wireTodoSnapshot = (seed?: (() => readonly TodoSnapshotItem[]) | null) => {
    const detach = todos.wireTodoSnapshot(seed);
    detachers.push(detach);
    return detach;
  };

  return {
    loopEvents: events.loopEvents,
    wireTodoSnapshot,
    resyncTodoSnapshot: todos.resyncTodoSnapshot,
    reg,
  };
}

afterEach(() => {
  // ORDER MATTERS: detach BEFORE clearing. `clear()` drops every listener, so a
  // later `unsub()` fires on an already-drained Set and is a silent no-op — the
  // leak that once made every second test lose its subscription.
  while (detachers.length) detachers.pop()!();
});

describe('wireTodoSnapshot — subscribes to the loop event bus', () => {
  it('a todo_changed event is pushed to the hub as a `todos` frame', async () => {
    const { loopEvents, wireTodoSnapshot, reg } = await setup();
    const { pushed, hub } = makeRecordingHub();
    reg.registerServeHubFactory(() => hub);

    wireTodoSnapshot();
    loopEvents.emit('todo_changed', { items: [item(1)], source: 'create' } satisfies TodoChangedPayload);

    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0].type).toBe('todos');
    expect(pushed[0].todos).toHaveLength(1);
  });

  it('omitting the seed still subscribes (a caller with no todo module is valid)', async () => {
    const { loopEvents, wireTodoSnapshot, reg } = await setup();
    const { pushed, hub } = makeRecordingHub();
    reg.registerServeHubFactory(() => hub);

    wireTodoSnapshot();
    loopEvents.emit('todo_changed', { items: [item(5)], source: 'pin' } satisfies TodoChangedPayload);

    await vi.waitFor(() => expect(pushed).toHaveLength(1));
  });

  it('the returned unsubscribe detaches the listener (no leak on teardown)', async () => {
    const { loopEvents, wireTodoSnapshot, reg } = await setup();
    const { pushed, hub } = makeRecordingHub();
    reg.registerServeHubFactory(() => hub);

    const detach = wireTodoSnapshot();
    detach();
    loopEvents.emit('todo_changed', { items: [item(1)], source: 'create' } satisfies TodoChangedPayload);

    await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toHaveLength(0);
  });

  it('each mutation reaches the hub, and the LAST frame reflects the latest state', async () => {
    // The push is ASYNC (it awaits a dynamic import before broadcasting), so a
    // synchronous burst of emits followed by ONE tick only lets the first frame
    // land. Drain between mutations — that is how production behaves too, since
    // a tool call is never instantaneous.
    const { loopEvents, wireTodoSnapshot, reg } = await setup();
    const { pushed, hub } = makeRecordingHub();
    reg.registerServeHubFactory(() => hub);
    wireTodoSnapshot();

    loopEvents.emit('todo_changed', { items: [item(1)], source: 'create' } satisfies TodoChangedPayload);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));

    loopEvents.emit('todo_changed', { items: [item(1, { done: true })], source: 'update' } satisfies TodoChangedPayload);
    await vi.waitFor(() => expect(pushed).toHaveLength(2));

    const last = pushed[pushed.length - 1];
    expect(last.todos).toHaveLength(1);
    expect(last.todos[0].done).toBe(true); // the LATEST state wins
  });

  it('a burst of mutations is delivered in order, ending on the newest state', async () => {
    const { loopEvents, wireTodoSnapshot, reg } = await setup();
    const { pushed, hub } = makeRecordingHub();
    reg.registerServeHubFactory(() => hub);
    wireTodoSnapshot();

    for (let i = 1; i <= 5; i++) {
      loopEvents.emit('todo_changed', { items: [item(1, { name: `v${i}` })], source: 'update' } satisfies TodoChangedPayload);
      await vi.waitFor(() => expect(pushed).toHaveLength(i));
    }
    expect(pushed[pushed.length - 1].todos[0].name).toBe('v5');
  });

  it('the wire frame whitelists: hash/previousHashes never reach the browser', async () => {
    // A REAL-shaped item carrying the anti-hallucination machinery. The panel
    // must never see it — only `toTodoListPayload` stands between the bus and
    // the browser, so there must be a lock on it.
    const { loopEvents, wireTodoSnapshot, reg } = await setup();
    const { pushed, hub } = makeRecordingHub();
    reg.registerServeHubFactory(() => hub);
    wireTodoSnapshot();

    loopEvents.emit('todo_changed', {
      items: [{ ...item(1), hash: 'deadbeef', previousHashes: ['cafe'] } as TodoSnapshotItem],
      source: 'create',
    } satisfies TodoChangedPayload);

    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const row = pushed[0].todos[0] as unknown as Record<string, unknown>;
    expect(row.hash).toBeUndefined();
    expect(row.previousHashes).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(['done', 'id', 'name', 'pinned']);
  });
});

describe('resyncTodoSnapshot — the SERVE-START seam (what activateServe calls)', () => {
  it('BOOT: installs the seed, then the serve start pushes the CURRENT list', async () => {
    const { wireTodoSnapshot, resyncTodoSnapshot } = await setup();
    const { pushed, hub } = hubWith(null); // fresh hub: no snapshot yet

    wireTodoSnapshot(() => [item(1), item(2)]);
    resyncTodoSnapshot(hub); // exactly what activateServe does after start()

    expect(pushed).toHaveLength(1);
    expect(pushed[0].todos).toHaveLength(2);
  });

  it('ESC → /serve RE-ENTRY: the snapshot stop() cleared is re-published', async () => {
    // THE DEFECT THIS LOCKS. `stop()` nulls the snapshot on a genuine shutdown
    // (correct), and the following `/serve` re-registers nothing, so no
    // registration hook can fire. Without the serve-start resync the panel stays
    // blank and `/history` returns `todos: null` — which the client applies as
    // an authoritative EMPTY list, wiping rows the agent still holds.
    const { wireTodoSnapshot, resyncTodoSnapshot } = await setup();
    wireTodoSnapshot(() => [item(1), item(2), item(3)]);

    // 1) boot: the panel gets the list.
    const boot = hubWith(null);
    resyncTodoSnapshot(boot.hub);
    expect(boot.pushed).toHaveLength(1);

    // 2) genuine stop() → the hub drops its snapshot; 3) `/serve` re-entry runs
    // the same seam again and must re-publish.
    const reEntry = hubWith(null);
    resyncTodoSnapshot(reEntry.hub);
    expect(reEntry.pushed).toHaveLength(1);
    expect(reEntry.pushed[0].todos).toHaveLength(3);
  });

  it('is IDEMPOTENT: re-running against an up-to-date hub adds no frame', async () => {
    // The old dedupe was defeated by an async push (both boot triggers compared
    // against `null`). This one is synchronous against the hub, so a second call
    // is a genuine no-op — and that is what makes the double trigger harmless.
    const { wireTodoSnapshot, resyncTodoSnapshot } = await setup();
    wireTodoSnapshot(() => [item(1)]);

    const first = hubWith(null);
    resyncTodoSnapshot(first.hub);
    expect(first.pushed).toHaveLength(1);

    const upToDate = hubWith(first.pushed[0]); // hub already holds exactly this
    resyncTodoSnapshot(upToDate.hub);
    expect(upToDate.pushed).toHaveLength(0); // no duplicate frame
  });

  it('a changed list DOES push even when a stale snapshot is present', async () => {
    const { wireTodoSnapshot, resyncTodoSnapshot } = await setup();
    let current: TodoSnapshotItem[] = [item(1)];
    wireTodoSnapshot(() => current);

    const boot = hubWith(null);
    resyncTodoSnapshot(boot.hub);
    expect(boot.pushed).toHaveLength(1);

    // The agent added a todo between serve starts; the hub still holds 1 row.
    current = [item(1), item(2)];
    const stale = hubWith(boot.pushed[0]);
    resyncTodoSnapshot(stale.hub);
    expect(stale.pushed).toHaveLength(1);
    expect(stale.pushed[0].todos).toHaveLength(2);
  });

  it('a THROWING seed cannot break serve startup', async () => {
    const { wireTodoSnapshot, resyncTodoSnapshot } = await setup();
    wireTodoSnapshot(() => { throw new Error('seed exploded'); });
    const { pushed, hub } = hubWith(null);
    expect(() => resyncTodoSnapshot(hub)).not.toThrow();
    expect(pushed).toHaveLength(0);
  });

  it('is a no-op when nothing installed a seed (a child process)', async () => {
    const { resyncTodoSnapshot } = await setup();
    const { pushed, hub } = hubWith(null);
    expect(() => resyncTodoSnapshot(hub)).not.toThrow();
    expect(pushed).toHaveLength(0);
  });
});
