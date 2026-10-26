/**
 * serve-restart-todolist.test.ts - a restart must NOT blank the todo panel.
 *
 * THE BUG: `ServeHub.stop()` nulled `this.todoList` unconditionally. Every
 * other lifecycle signal in that method is gated on `!this.restarting`
 * (`setWebUiUp(false)` at :632, `getSteeringManager().clear()` at :650) because
 * "a recycle is INVISIBLE" — the todo snapshot was the exception. `stop(true)`
 * therefore wiped it on every 重启 click AND on every stop → `/serve` re-entry
 * inside one process, and nothing re-pushed it: the `onServeHubReady` queue is
 * drained once per process (`splice`) and `ensureServeHub()` short-circuits on
 * `if (!factory)`, so the seed never re-ran. Observable result: the panel was
 * empty and `/history` returned `todos: null` until the next mutation — which
 * the client applies as an authoritative EMPTY replacement, i.e. visible row
 * loss.
 *
 * THE FIX, in two halves — both lock here:
 *   1. `stop()` gates the null on `!this.restarting`, so a recycle keeps the
 *      snapshot (a genuine shutdown still clears it).
 *   2. the seed re-syncs on every hub APPEARANCE via
 *      the serve-start seam (`activateServe` → `resyncTodoSnapshot`), not once per process.
 *
 * These drive a REAL ServeHub with the heavy IO stubbed (no socket, no vite):
 * the subject is the snapshot's lifecycle, not the server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServeHub } from '../../serve/serve-hub.js';
import { toTodoListPayload } from '../../serve/serve-todos.js';

const payload = toTodoListPayload([
  { id: 1, name: 'Task A', done: false, pinned: false },
]);

/** Read the hub's cached snapshot without widening the production type. */
const snapshotOf = (hub: ServeHub): unknown =>
  (hub as unknown as { todoList: unknown }).todoList;

describe('a serve recycle keeps the todo snapshot (restart is INVISIBLE)', () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
    hub.broadcastTodoList(payload); // an active serve with rows on screen
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stop() during a restart does NOT null the snapshot', async () => {
    // Real stop() body, heavy IO stubbed so nothing is bound or disposed.
    vi.spyOn(hub as unknown as { disposeStack: () => Promise<void> }, 'disposeStack')
      .mockImplementation(async () => { /* no stack */ });
    vi.spyOn(hub as unknown as { abortInput: () => void }, 'abortInput')
      .mockImplementation(() => { /* no input */ });
    vi.spyOn(hub as unknown as { disconnectTimer: { cancel: () => void } }, 'disconnectTimer', 'get')
      .mockReturnValue({ cancel: () => { /* no timer */ } } as never);
    vi.spyOn(hub as unknown as { clients: { closeAll: () => void } }, 'clients', 'get')
      .mockReturnValue({ closeAll: () => { /* no clients */ } } as never);

    (hub as unknown as { restarting: boolean }).restarting = true; // restartServe() sets this first
    await hub.stop(true);

    expect(snapshotOf(hub)).toEqual(payload); // rows SURVIVE the recycle
  });

  it('stop() on a GENUINE shutdown still clears the snapshot', async () => {
    vi.spyOn(hub as unknown as { disposeStack: () => Promise<void> }, 'disposeStack')
      .mockImplementation(async () => { /* no stack */ });
    vi.spyOn(hub as unknown as { abortInput: () => void }, 'abortInput')
      .mockImplementation(() => { /* no input */ });
    vi.spyOn(hub as unknown as { disconnectTimer: { cancel: () => void } }, 'disconnectTimer', 'get')
      .mockReturnValue({ cancel: () => { /* no timer */ } } as never);
    vi.spyOn(hub as unknown as { clients: { closeAll: () => void } }, 'clients', 'get')
      .mockReturnValue({ closeAll: () => { /* no clients */ } } as never);

    (hub as unknown as { restarting: boolean }).restarting = false;
    await hub.stop(true);

    expect(snapshotOf(hub)).toBeNull(); // a real teardown serves nothing
  });
});
