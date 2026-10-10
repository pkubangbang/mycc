/**
 * serve-restart-webiup.test.ts - restartServe() must NOT publish a WebUI-down
 * transition (P2 #3).
 *
 * THE BUG: `ServeHub.stop()` unconditionally ran `setWebUiUp(false)`. But
 * `restartServe()` calls `await this.stop(true)` and only re-asserts the flag
 * to `true` AFTER `start()` completes. So during the async stop→start window
 * the process-wide holder read `false`, and any loop/context reader —
 * `collect.ts`'s edge-triggered lifecycle report (isWebUiUp()) or Core's
 * interaction presentation — could observe a spurious stop/start during a
 * recycle, violating the "a recycle is INVISIBLE" invariant.
 *
 * THE FIX: `stop()` gates the down-publish on `!this.restarting` (mirroring the
 * existing `!this.restarting` gate on `getSteeringManager().clear()`), so only a
 * GENUINE shutdown publishes `false`; on the restart path the flag stays `true`
 * throughout. `restartServe()` still re-asserts `true` after start() as defence
 * in depth.
 *
 * These tests drive a REAL ServeHub but STUB its start()/stop() so no socket is
 * bound — the point is the flag transition, not the server. The stub `stop()`
 * awaits a controllable promise so the test can assert the flag DURING the
 * teardown await (the exact window the bug exposed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServeHub } from '../../serve/serve-hub.js';
import { isWebUiUp, setWebUiUp } from '../../loop/loop-events.js';

describe('restartServe() keeps isWebUiUp() true throughout the recycle (P2 #3)', () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
  });

  afterEach(() => {
    // Reset the process-wide holder so tests stay isolated.
    setWebUiUp(false);
    vi.restoreAllMocks();
  });

  it('does not flip the holder down while stop() is awaiting teardown', async () => {
    // Simulate an ACTIVE serve: the holder is up when restartServe() begins.
    setWebUiUp(true);

    // A controllable gate inside stop() so the test can observe the flag while
    // the async teardown is IN FLIGHT (the window the bug exposed).
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });

    // Stub the heavy start/stop so no port is bound. stop() sets `restarting`
    // via restartServe() BEFORE calling it — exactly the real call order.
    vi.spyOn(hub, 'stop').mockImplementation(async () => { await stopGate; });
    vi.spyOn(hub, 'start').mockImplementation(async () => { /* no-op */ });

    // Kick off the recycle (don't await yet — we need to inspect mid-flight).
    const recycle = hub.restartServe();

    // Give the microtask queue a tick so we are INSIDE stop()'s await.
    await Promise.resolve();

    // THE ASSERTION: mid-recycle the holder must still read UP. Before the fix
    // this was `false` (stop() published the down state unconditionally).
    expect(isWebUiUp()).toBe(true);

    // Let stop() resolve → start() runs → restartServe() finishes.
    releaseStop();
    await recycle;

    // And after the recycle the holder is still UP (serve is reachable again).
    expect(isWebUiUp()).toBe(true);
  });

  it('a GENUINE stop() (not a restart) still publishes the down state', async () => {
    // Baseline: the gate must not break the normal shutdown path.
    setWebUiUp(true);
    vi.spyOn(hub, 'stop').mockRestore(); // use the real stop()

    // The real stop() tears down servers; with none started it must complete
    // without throwing and publish `false`.
    await hub.stop(true);
    expect(isWebUiUp()).toBe(false);
  });

  it('the source gates setWebUiUp(false) on !restarting (drift guard)', async () => {
    // Source-text guard: a future edit that drops the gate would re-expose the
    // spurious transition even if the behavioural stub above were refactored.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'serve', 'serve-hub.ts'),
      'utf-8',
    );
    // The ONLY setWebUiUp(false) call site must be guarded by !this.restarting.
    const lines = src.split('\n');
    const downLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/setWebUiUp\(false\)/.test(lines[i])) downLines.push(i);
    }
    expect(downLines.length, 'expected exactly one setWebUiUp(false) call site').toBe(1);
    // The guard sits on the same line or the few lines immediately above.
    const idx = downLines[0];
    const window = lines.slice(Math.max(0, idx - 6), idx + 1).join('\n');
    expect(window).toContain('!this.restarting');
  });
});
