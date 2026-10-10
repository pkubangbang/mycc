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

  it('a FAILED restartServe() publishes the down state (holder must not read up)', async () => {
    // P2 (remaining issue): start() throwing mid-recycle skips the
    // setWebUiUp(true) re-assert, but stop(true) also SKIPPED the down-publish
    // (gated on !restarting), leaving the holder stuck at `true` while the
    // server is actually down. The failure path must publish `false`.
    setWebUiUp(true); // active serve before the recycle begins

    // stop(true) no-ops (real recycle would tear down; here we only care that
    // it does NOT publish `false` mid-flight), and start() REJECTS.
    vi.spyOn(hub, 'stop').mockImplementation(async () => { /* no-op */ });
    vi.spyOn(hub, 'start').mockImplementation(async () => {
      throw new Error('start failed');
    });

    await expect(hub.restartServe()).rejects.toThrow('start failed');

    // After the failed recycle, the holder must read DOWN, not the stale `true`.
    expect(isWebUiUp()).toBe(false);
  });

  it('a FAILED restartServe() settles the outstanding input wait', async () => {
    // P2 (remaining issue #2): stop(true) deliberately skips abortInput() so a
    // pending waitForInput() survives a recycle — but on a FAILED recycle the
    // server never comes back, so that wait must be resolved (with null) or a
    // headless daemon blocks forever on input that can no longer arrive.
    setWebUiUp(true); // active serve before the recycle begins

    // Arm a pending input wait BEFORE the restart (mimics WebInputProvider
    // blocking inside getInput() while the user clicks 重启).
    const pendingWait = hub.waitForInput();

    vi.spyOn(hub, 'stop').mockImplementation(async () => { /* no-op */ });
    vi.spyOn(hub, 'start').mockImplementation(async () => {
      throw new Error('start failed');
    });

    await expect(hub.restartServe()).rejects.toThrow('start failed');

    // The pending wait must have SETTLED (resolved null), not remain pending
    // forever. A resolved-null is exactly what WebInputProvider's three-way
    // guard reads to apply daemon-exit / terminal-fallback handling.
    const settled = await Promise.race([
      pendingWait.then((v) => ({ status: 'settled' as const, value: v })),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(settled.status).toBe('settled');
    expect((settled as { value: string | null }).value).toBeNull();
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
    // Two legitimate setWebUiUp(false) call sites now exist:
    //   1. stop()'s down-publish — MUST be guarded by !this.restarting.
    //   2. restartServe()'s failure-path down-publish (catch block) — only
    //      fires when start() throws, so it must NOT be restarting-gated.
    const lines = src.split('\n');
    const downLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/setWebUiUp\(false\)/.test(lines[i])) downLines.push(i);
    }
    expect(downLines.length, 'expected exactly two setWebUiUp(false) call sites').toBe(2);
    // Site 1 (stop): the guard sits on the same line or the few lines above.
    const stopIdx = downLines[0];
    const stopWindow = lines.slice(Math.max(0, stopIdx - 6), stopIdx + 1).join('\n');
    expect(stopWindow).toContain('!this.restarting');
    // Site 2 (restartServe failure path): must live inside restartServe()'s
    // catch block — i.e. AFTER the method signature, AFTER the success-path
    // setWebUiUp(true), and BEFORE the rethrow. Assert ORDER via line numbers
    // (not a fixed window, which drifts as comments/calls grow).
    const restartIdx = downLines[1];
    expect(restartIdx, 'failure-path down-publish must follow the stop() site').toBeGreaterThan(stopIdx);
    const methodLine = lines.findIndex((l) => /async restartServe/.test(l));
    // The success-path setWebUiUp(true) and the rethrow must be AFTER the
    // method signature (the file has an earlier setWebUiUp(true) mention in
    // start()'s comment, so search only within restartServe's tail).
    const methodTail = lines.slice(methodLine);
    const upLine = methodLine + methodTail.findIndex((l) => /setWebUiUp\(true\)/.test(l));
    const throwLine = methodLine + methodTail.findIndex((l) => /throw err/.test(l));
    expect(methodLine, 'restartServe method signature found').toBeGreaterThanOrEqual(0);
    expect(upLine, 'success-path setWebUiUp(true) found').toBeGreaterThan(methodLine);
    expect(throwLine, 'failure rethrow found').toBeGreaterThan(upLine);
    // The failure-path down-publish sits AFTER the success re-assert and BEFORE
    // the rethrow (i.e. inside the catch block).
    expect(restartIdx).toBeGreaterThan(upLine);
    expect(restartIdx).toBeLessThan(throwLine);
    // The failure-path publish must NOT be guarded by `!this.restarting`: only
    // stop()'s down-publish is gated (so a recycle stays invisible). A failed
    // recycle must unconditionally publish `false`. Assert the GUARD line count
    // is exactly one (the stop() site), not by scanning prose comments that
    // legitimately mention `!this.restarting`.
    const guardLines = lines.filter((l) => /if\s*\(!this\.restarting\)\s*setWebUiUp\(false\)/.test(l));
    expect(guardLines.length, 'exactly one restarting-gated setWebUiUp(false) guard').toBe(1);
  });
});
