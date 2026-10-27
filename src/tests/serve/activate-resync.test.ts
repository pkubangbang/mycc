/**
 * activate-resync.test.ts - `activateServe()` must re-publish the todo snapshot.
 *
 * THE DEFECT THIS LOCKS (found across three review rounds, measured twice):
 * the panel's snapshot was seeded from a serve-REGISTRATION hook. But
 * `registerServeHubFactory` has only two callers — `ServeHub`'s constructor
 * (once per process) and `ensureServeHub` (only while `factory` is unset) — and
 * `restartServe()` calls neither. So a `stop()` → `/serve` RE-ENTRY inside one
 * process re-registers nothing, no hook fires, `ServeHub.stop()` has already
 * nulled the snapshot, and `/history` answers `todos: null`. The client applies
 * that as an authoritative EMPTY list, wiping a panel whose rows the agent
 * still holds. An earlier lock passed while this shipped, because it called
 * `registerServeHubFactory` twice — a path production never takes.
 *
 * THE FIX: `activateServe()` is the ONLY code that runs on the first start AND
 * on every re-entry, so it calls `resyncTodoSnapshot(hub)` after `hub.start()`.
 *
 * These tests drive the REAL `activateServe()` (imported, not re-implemented),
 * with `ensureServeHub` replaced by a stub hub so no socket, Vite or tmux is
 * involved. That is the point: the assertion is about the SEAM, and the seam is
 * what was missing. `resyncTodoSnapshot` itself is NOT mocked — it is the
 * production implementation under test via its module-scope `installedSeed`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TodoListPayload } from '../../serve/serve-todos.js';

/** The stub hub handed to the real `activateServe`. */
type StubHub = {
  isRunning: () => boolean;
  getUrl: () => string | null;
  getUrls: () => { local: string; network: string[] } | null;
  start: () => Promise<void>;
  broadcast: () => void;
  broadcastTodoList: (p: TodoListPayload) => void;
  getTodoSnapshot: () => TodoListPayload | null;
};

let pushed: TodoListPayload[];
let stubSnapshot: TodoListPayload | null;
let stubHub: StubHub;

/** Wire the module graph: real activate/serve-todos, stubbed registry. */
async function setup() {
  vi.resetModules();
  pushed = [];
  stubSnapshot = null;
  stubHub = {
    isRunning: () => false,
    getUrl: () => null,
    getUrls: () => ({ local: 'http://127.0.0.1:3191', network: [] }),
    start: async () => { /* no socket */ },
    broadcast: () => { /* no ws */ },
    broadcastTodoList: (p) => { pushed.push(p); stubSnapshot = p; },
    getTodoSnapshot: () => stubSnapshot,
  };

  // `activate.ts` imports these; stub the registry so `ensureServeHub` returns
  // our hub without loading express/vite/ws.
  vi.doMock('../../serve/serve-registry.js', () => ({
    ensureServeHub: async () => stubHub,
    tryGetServeHub: () => stubHub,
    onServeHubReady: () => {},
    onServeHubReRegistered: () => {},
    registerServeHubFactory: () => {},
  }));
  vi.doMock('../../loop/agent-io.js', () => ({
    // `wireOutputMirroring` installs two callbacks; both must exist.
    agentIO: {
      verbose: false,
      setOutputCallback: () => {},
      setResultCallback: () => {},
    },
  }));
  vi.doMock('../../utils/letter-box.js', () => ({ setResultCallback: () => {} }));
  vi.doMock('../../utils/parent-ipc.js', () => ({ sendToParent: () => {} }));
  vi.doMock('../../loop/loop-events.js', () => ({
    setWebUiUp: () => {},
    isWebUiUp: () => false,
    loopEvents: { on: () => () => {}, emit: () => {}, hasListeners: () => false },
  }));

  const activate = await import('../../serve/activate.js');
  const todos = await import('../../serve/serve-todos.js');
  return { activateServe: activate.activateServe, wireTodoSnapshot: todos.wireTodoSnapshot };
}

describe('activateServe() re-publishes the todo snapshot (start AND re-entry)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.doUnmock('../../serve/serve-registry.js');
    vi.doUnmock('../../loop/agent-io.js');
    vi.doUnmock('../../utils/letter-box.js');
    vi.doUnmock('../../utils/parent-ipc.js');
    vi.doUnmock('../../loop/loop-events.js');
  });

  it('FIRST START: pushes the seeded list to the hub', async () => {
    const { activateServe, wireTodoSnapshot } = await setup();
    wireTodoSnapshot(() => [{ id: 1, name: 'Task A', done: false, pinned: false }]);

    await activateServe(3191);

    expect(pushed).toHaveLength(1);
    expect(pushed[0].todos).toHaveLength(1);
  });

  it('ESC → /serve RE-ENTRY: the snapshot stop() cleared is republished', async () => {
    // The whole point. `stop()` nulled the hub's snapshot; the re-entry
    // re-registers nothing, so ONLY this seam can restore the panel.
    const { activateServe, wireTodoSnapshot } = await setup();
    wireTodoSnapshot(() => [
      { id: 1, name: 'Task A', done: false, pinned: false },
      { id: 2, name: 'Task B', done: true, pinned: false },
    ]);

    await activateServe(3191);
    expect(pushed).toHaveLength(1);

    // Simulate `ServeHub.stop()`: the hub drops its snapshot.
    stubSnapshot = null;
    pushed = [];

    await activateServe(3191); // the /serve slash, same process
    expect(pushed).toHaveLength(1);
    expect(pushed[0].todos).toHaveLength(2);
  });

  it('does not emit a duplicate frame when the hub is already up to date', async () => {
    const { activateServe, wireTodoSnapshot } = await setup();
    wireTodoSnapshot(() => [{ id: 1, name: 'Task A', done: false, pinned: false }]);

    await activateServe(3191);
    expect(pushed).toHaveLength(1);

    await activateServe(3191); // snapshot still current
    expect(pushed).toHaveLength(1); // no second frame
  });

  it('is a no-op when nothing installed a seed (a child process)', async () => {
    const { activateServe } = await setup();
    await expect(activateServe(3191)).resolves.toBeUndefined();
    expect(pushed).toHaveLength(0);
  });

  it('a throwing seed cannot break serve startup', async () => {
    const { activateServe, wireTodoSnapshot } = await setup();
    wireTodoSnapshot(() => { throw new Error('seed exploded'); });
    await expect(activateServe(3191)).resolves.toBeUndefined();
    expect(pushed).toHaveLength(0);
  });
});
