/**
 * serve-start-failure.test.ts - start()'s startup-failure cleanup (review P2).
 *
 * THE BUG (review finding P2): a `start()` that throws MID-initialization —
 * e.g. `httpServer.listen` failing with EADDRINUSE AFTER Vite, the WS server
 * and the peer-wire acceptor have already been created — left the hub
 * partially initialized. The old code had no catch, so the thrown error
 * propagated with the Vite watcher/esbuild process, the HTTP server and the
 * peer-wire acceptor still live. A later retry (`/serve` again) would
 * overwrite those fields with fresh handles, leaking the originals.
 *
 * THE FIX: the stack mount is wrapped in try/catch; on any throw it awaits
 * `disposeStack()` (which releases the HTTP/Vite/WS/peer-wire resources
 * WITHOUT touching lifecycle state) and rethrows. `disposeStack()` is the same
 * routine `stop()` uses — one release path for both the full teardown and the
 * failure path. The lifecycle STATE (running / messageLog) is cleared by
 * ServeLifecycleState.start()'s catch, which owns those transitions.
 *
 * POST-EXTRACTION (see serve-web-stack.ts / serve-lifecycle.ts): the handles
 * now live in the web-stack module's closure, so the release is observed at
 * the HUB seam — `disposeStack()` — rather than by reading `hub.httpServer`.
 * The invariant asserted is unchanged: the shared release routine runs exactly
 * once on the failure path, the stack is gone, and the error still propagates.
 *
 * ── ISSUE #10: WHAT THIS FILE USED TO GET WRONG ─────────────────────────────
 * Two of the old assertions could not fail for the regression they named, and
 * this file has been rewritten around what the failure path ACTUALLY does:
 *
 *  1. `expect(internals.webStack).toBeNull()` was a TAUTOLOGY. `startStack()`
 *     is `this.webStack = await mountWebStack(...)` (serve-hub.ts), so a throw
 *     inside mountWebStack means the assignment NEVER RUNS and the field is
 *     still its initial `null` (:61). The assertion held because nothing was
 *     ever assigned, not because something was released. It has been DROPPED —
 *     do not restore it. (The retry test's `.not.toBeNull()` below is what
 *     proves the field CAN be non-null, on the success path; a null-after-fail
 *     assertion adds nothing to that.)
 *
 *  2. `expect(disposeSpy).toHaveBeenCalledTimes(1)` PASSED FOR THE WRONG
 *     REASON, and the comment above it ("proves the failure path INVOKED the
 *     shared release routine") was false. On a mount-internal failure the hub's
 *     `disposeStack()` IS called once — by ServeLifecycleState.start()'s catch —
 *     but it finds `webStack === null` and therefore releases NOTHING. The
 *     count is a STATE-MACHINE contract (the catch reaches its hook), not a
 *     release contract, and it is now labelled as such.
 *
 * THE REAL RELEASE GUARD (new): mountWebStack's own catch awaits its local
 * `dispose()`, which calls `getPeerWireAcceptor().stop()` after the acceptor's
 * server was created a few lines earlier. That call is the ONLY observable
 * evidence that the partially-built stack was released, so it is what the test
 * asserts — with a mutation that proves it (delete `await dispose()` in the
 * catch ⇒ acceptor.stop never runs ⇒ RED).
 *
 * These tests drive a REAL ServeHub (no socket is left bound) and force the
 * failure at the listen step by pre-binding the port, so the failure lands
 * exactly where the bug describes: after Vite/WS/peer-wire exist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import * as net from 'node:net';
import { ServeHub } from '../../serve/serve-hub.js';
import { getPeerWireAcceptor, resetPeerWireAcceptor } from '../../serve/peer-wire.js';

/** Cast-away-privacy view of the hub internals these tests inspect. */
type HubInternals = {
  webStack: unknown;
  disposeStack(): Promise<void>;
};

describe('ServeHub.start() releases a partially-initialized stack on failure (P2)', () => {
  /** A pre-bound server squatting on the port so listen() rejects EADDRINUSE. */
  let squatter: net.Server | null = null;
  let boundPort = 0;

  beforeEach(async () => {
    resetPeerWireAcceptor();
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
    resetPeerWireAcceptor();
    vi.restoreAllMocks();
  });

  it('releases the peer-wire acceptor and rethrows when listen() fails mid-init', async () => {
    const hub = new ServeHub();
    const internals = hub as unknown as HubInternals;

    // THE RELEASE GUARD: mountWebStack creates the acceptor's server before it
    // binds, and its catch must stop that acceptor. Without `await dispose()`
    // the acceptor (and its ping timer + Vite watcher) would survive the throw.
    const acceptorStop = vi.spyOn(getPeerWireAcceptor(), 'stop');
    // The STATE-MACHINE seam: start()'s catch must reach the hub hook exactly
    // once. On THIS path the hook is a no-op (the stack was never assigned), so
    // this count is NOT evidence of a release — see the header note (2).
    const disposeSpy = vi.spyOn(internals, 'disposeStack');

    await expect(hub.start(boundPort, '127.0.0.1')).rejects.toThrow();

    expect(acceptorStop, 'the partially-built stack released the peer-wire acceptor').toHaveBeenCalled();
    expect(disposeSpy, 'the lifecycle catch reached the hub release seam exactly once').toHaveBeenCalledTimes(1);

    // running stays false: start() only flips it true on its final line, which
    // the throw skipped. isRunning() must therefore read false post-failure.
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
      expect(internals.webStack).not.toBeNull();
    } finally {
      // Always tear down whatever this attempt bound.
      await hub.stop(true).catch(() => {
        /* ignore */
      });
    }
  });
});
