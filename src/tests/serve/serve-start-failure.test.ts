/**
 * serve-start-failure.test.ts - start()'s startup-failure cleanup (review P2).
 *
 * THE BUG (review finding P2): a `start()` that throws MID-initialization —
 * e.g. `httpServer.listen` failing with EADDRINUSE AFTER Vite, the WS server
 * and the peer-wire acceptor have already been created — left this hub
 * partially initialized. The old code had no catch, so the thrown error
 * propagated with the Vite watcher/esbuild process, the HTTP server and the
 * peer-wire acceptor still live. A later retry (`/serve` again) would
 * overwrite those fields with fresh handles, leaking the originals.
 *
 * THE FIX: `start()` wraps its body in try/catch; on any throw it sets
 * `running=false`, awaits `disposeStack()` (which releases the HTTP/Vite/WS/
 * peer-wire resources WITHOUT touching lifecycle state), resets the
 * messageLog, and rethrows. `disposeStack()` is the same helper `stop()` now
 * uses — extracted so both the full teardown and the failure path share one
 * release routine.
 *
 * These tests drive a REAL ServeHub (no socket is left bound) and force the
 * failure at the listen step by pre-binding the port, so the failure lands
 * exactly where the bug describes: after Vite/WS/peer-wire exist. We assert
 * the handles were released and the error still propagates (so callers keep
 * their existing failure handling — activateServe's "Terminal mode continues"
 * message, restartServe's down-publish + input wake).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import { ServeHub } from '../../serve/serve-hub.js';

/** Cast-away-privacy view of the hub internals these tests inspect. */
type HubInternals = {
  httpServer: unknown;
  viteServer: unknown;
  wsServer: unknown;
  expressApp: unknown;
  running: boolean;
  disposeStack(): Promise<void>;
};

describe('ServeHub.start() releases a partially-initialized stack on failure (P2)', () => {
  /** A pre-bound server squatting on the port so listen() rejects EADDRINUSE. */
  let squatter: net.Server | null = null;
  let boundPort = 0;

  beforeEach(async () => {
    // Bind an ephemeral port, then learn its number. start() will target it
    // and fail at listen() — AFTER Vite/WS/peer-wire have been built.
    squatter = net.createServer();
    await new Promise<void>((resolve) => squatter!.listen(0, '127.0.0.1', () => resolve()));
    boundPort = (squatter!.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    if (squatter) {
      await new Promise<void>((resolve) => squatter!.close(() => resolve()));
      squatter = null;
    }
    vi.restoreAllMocks();
  });

  it('releases the stack and rethrows when listen() fails mid-init', async () => {
    const hub = new ServeHub();
    const internals = hub as unknown as HubInternals;

    // Spy on disposeStack so we can prove the failure path INVOKED the shared
    // release routine (not merely that the fields happen to be null).
    const disposeSpy = vi.spyOn(internals, 'disposeStack');

    await expect(hub.start(boundPort, '127.0.0.1')).rejects.toThrow();

    // The shared release routine ran exactly once on the failure path.
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    // Every server handle was released — a later retry must not overwrite a
    // live handle (the leak the fix closes).
    expect(internals.httpServer).toBeNull();
    expect(internals.viteServer).toBeNull();
    expect(internals.wsServer).toBeNull();
    expect(internals.expressApp).toBeNull();

    // running stays false: start() only flips it true on its final line, which
    // the throw skipped. isRunning() must therefore read false post-failure.
    expect(internals.running).toBe(false);
    expect(hub.isRunning()).toBe(false);
  });

  it('a retry after a failed start() can succeed (no leaked handle blocks it)', async () => {
    const hub = new ServeHub();
    const internals = hub as unknown as HubInternals;

    // First attempt fails against the squatted port.
    await expect(hub.start(boundPort, '127.0.0.1')).rejects.toThrow();
    expect(hub.isRunning()).toBe(false);

    // Release the squatter so the SAME hub can rebind a free port — this is
    // the real user flow (/serve fails on a busy port; user fixes it and
    // retries). It only works if the failed attempt freed its handles.
    await new Promise<void>((resolve) => squatter!.close(() => resolve()));
    squatter = null;

    try {
      await hub.start(boundPort, '127.0.0.1');
      expect(hub.isRunning()).toBe(true);
      expect(internals.httpServer).not.toBeNull();
    } finally {
      // Always tear down whatever this attempt bound.
      await hub.stop(true).catch(() => { /* ignore */ });
    }
  });
});
