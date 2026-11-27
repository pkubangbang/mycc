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
 * THE FIX: `stop()` gates the down-publish on `!restarting` (mirroring the
 * existing gate on `getSteeringManager().clear()`), so only a GENUINE shutdown
 * publishes `false`; on the restart path the flag stays `true` throughout.
 * `restartServe()` still re-asserts `true` after start() as defence in depth.
 *
 * ── ISSUE #10: WHY THESE TESTS WERE REWRITTEN ──────────────────────────────
 * The previous version of this file stubbed `lifecycle.stop()` ENTIRELY:
 *
 *     vi.spyOn(lifecycle, 'stop').mockImplementation(async () => { await gate; })
 *
 * That replaced the very method under test, so the gate inside `stop()` never
 * executed. The mid-recycle assertion `expect(isWebUiUp()).toBe(true)` could
 * therefore not fail for the bug it names — deleting the gate, inverting
 * `isRecycling()` or dropping the publish all left it green. It asserted that
 * the STUB was reached, not that the gate worked: a vacuous guard.
 *
 * The tests below drive the REAL `stop()` / `real restartServe()` and stub only
 * the HUB PLUMBING (bind a port, wipe the steering singleton, print). The gate
 * is on the path, so every mutation of it is observable in the process-wide
 * holder. Each test names the mutation it catches.
 *
 * POST-EXTRACTION SEAMS (see serve-lifecycle.ts): the transitions moved out of
 * ServeHub into `ServeLifecycleState`, which the hub delegates to. The machine
 * captures the hub's `lifecycleHost` view ONCE at construction, and every hook
 * in that view is an arrow closing over the hub (`disposeStack: () => this.
 * disposeStack()`), so spying the hub's own private method IS spying the hook.
 * `hub.lifecycleHost` itself is a GETTER that builds a fresh object per call —
 * spying on it would observe nothing (the machine holds the first object); that
 * is why the stubs below patch the hub methods, not the view.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { ServeHub } from '../../serve/serve-hub.js';
import { isWebUiUp, setWebUiUp } from '../../loop/loop-events.js';
import { getSteeringManager } from '../../loop/steering-manager.js';
import type { SteeringDeliveredInput } from '../../serve/serve-types.js';

/** The hub's private plumbing seams the lifecycle machine invokes. */
type HubPlumbing = {
  startStack(port: number, host: string | null): Promise<void>;
  disposeStack(): Promise<void>;
  notifyParentInactive(): void;
  closeAllClients(): void;
  clearSteering(): void;
  resetMessageLog(): void;
  subscribeSteering(): void;
  unsubscribeSteeringObserver(): void;
  rewireOutputMirroringCallback(): void;
  log(msg: string): void;
  printRestored(): void;
};

/**
 * Stub every hub hook that binds a socket, spawns Vite, wipes the steering
 * singleton or writes to the console — leaving the STATE MACHINE real.
 *
 * `publishWebUiDown` / `publishWebUiUp` are deliberately NOT stubbed: they are
 * the observable under test, and they are call-through spies so the holder (the
 * thing the loop actually reads) is still driven by the production code.
 */
function stubPlumbing(hub: ServeHub, startStack: () => Promise<void>): void {
  const plumbing = hub as unknown as HubPlumbing;
  vi.spyOn(plumbing, 'startStack').mockImplementation(startStack);
  vi.spyOn(plumbing, 'disposeStack').mockImplementation(async () => undefined);
  vi.spyOn(plumbing, 'notifyParentInactive').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'clearSteering').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'resetMessageLog').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'subscribeSteering').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'unsubscribeSteeringObserver').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'rewireOutputMirroringCallback').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'log').mockImplementation(() => undefined);
  vi.spyOn(plumbing, 'printRestored').mockImplementation(() => undefined);
}

/** Resolve after `n` microtask turns (the machine only awaits on purpose). */
async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Comment-stripped source: assertions below must bind CODE, never prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/** Whitespace-normalised code (layout-free, so the formatter cannot break it). */
function normalise(src: string): string {
  return stripComments(src).replace(/\s+/g, ' ').trim();
}

describe('restartServe() keeps isWebUiUp() true throughout the recycle (P2 #3)', () => {
  let hub: ServeHub;

  beforeEach(() => {
    hub = new ServeHub();
  });

  afterEach(() => {
    setWebUiUp(false);
    getSteeringManager().clear();
    vi.restoreAllMocks();
  });

  /**
   * CATCHES: "delete the gate" (publishDownUnlessRecycling made unconditional)
   * and "invert isRecycling()" (returns !restarting).
   *
   * Both mutations make the REAL stop() publish `down` while `restarting` is
   * true, so the holder reads false at the moment asserted here. The startStack
   * gate holds the recycle open INSIDE the stop→start window — the exact window
   * the original bug exposed — with the real state machine in flight.
   */
  it('does not flip the holder down inside the stop()→start() window of a recycle', async () => {
    // Hold the recycle open while we look. `startStack` blocks only once the
    // gate is ARMED, so the initial start() below still resolves normally.
    let releaseStart!: () => void;
    let gate: Promise<void> | null = null;
    stubPlumbing(hub, async () => {
      if (gate) await gate;
    });
    const publishDown = vi.spyOn(hub as unknown as { publishWebUiDown(): void }, 'publishWebUiDown');

    // An ACTIVE serve: the holder is up and the machine thinks it is running
    // (start() is a no-op for an already-running hub, so running must be true
    // for restartServe() to reach startStack at all).
    await hub.start(0);
    expect(hub.isRunning()).toBe(true);
    setWebUiUp(true);
    publishDown.mockClear();

    gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const recycle = hub.restartServe();

    // We are now inside startStack's await: stop() has ALREADY run with
    // `restarting === true`, which is the window the bug exposed.
    await flush();
    expect(publishDown, 'a recycle must not publish a down transition').not.toHaveBeenCalled();
    expect(isWebUiUp(), 'the holder reads UP mid-recycle').toBe(true);

    releaseStart();
    await recycle;

    // And after the recycle the holder is still UP (serve is reachable again).
    expect(isWebUiUp()).toBe(true);
    expect(publishDown, 'a successful recycle still publishes no down transition').not.toHaveBeenCalled();
  });

  /**
   * CATCHES: dropping the publish from restartServe()'s FAILURE branch.
   *
   * stop(true) skipped the down-publish (mid-recycle) and start() throwing
   * skipped publishWebUiUp(), so without the failure-branch publish the holder
   * stays stuck `true` while the server is actually down — a browser that keeps
   * reconnecting to a corpse. Asserting the real holder (not a spy count) makes
   * this fail for exactly that mutation.
   */
  it('a FAILED restartServe() publishes the down state (holder must not read up)', async () => {
    // Only the RECYCLE's start fails; the initial start() must succeed so the
    // hub is genuinely UP when the recycle begins.
    const failOn = { recycle: false };
    stubPlumbing(hub, async () => {
      if (failOn.recycle) throw new Error('start failed');
    });

    await hub.start(0);
    setWebUiUp(true); // active serve before the recycle begins
    failOn.recycle = true;

    await expect(hub.restartServe()).rejects.toThrow('start failed');

    // After the failed recycle, the holder must read DOWN, not the stale `true`.
    expect(isWebUiUp()).toBe(false);
    // ...and it is DOWN because the seam ran, not by accident of test order.
    expect(hub.isRunning()).toBe(false);
  });

  it('a FAILED restartServe() settles the outstanding input wait', async () => {
    // stop(true) deliberately skips abortInput() so a pending waitForInput()
    // survives a recycle — but on a FAILED recycle the server never comes back,
    // so that wait must be resolved (with null) or a headless daemon blocks
    // forever on input that can no longer arrive.
    const failOn = { recycle: false };
    stubPlumbing(hub, async () => {
      if (failOn.recycle) throw new Error('start failed');
    });

    await hub.start(0);
    setWebUiUp(true); // active serve before the recycle begins

    // Arm a pending input wait BEFORE the restart (mimics WebInputProvider
    // blocking inside getInput() while the user clicks 重启).
    const pendingWait = hub.waitForInput();
    failOn.recycle = true;

    await expect(hub.restartServe()).rejects.toThrow('start failed');

    // The pending wait must have SETTLED (resolved null), not remain pending
    // forever. A resolved-null is exactly what WebInputProvider's three-way
    // guard reads to apply daemon-exit / terminal-fallback handling.
    const settled = await Promise.race([
      pendingWait.then((v) => ({ status: 'settled' as const, value: v })),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50))
    ]);
    expect(settled.status).toBe('settled');
    expect((settled as { value: SteeringDeliveredInput }).value.text).toBeNull();
  });

  /**
   * CATCHES: inverting the gate into `publishDownUnlessRecycling()` skipping a
   * GENUINE teardown (a gate that only fires mid-recycle). The other half of
   * the polarity: the gate must SUPPRESS a recycle and PRESERVE a shutdown.
   */
  it('a GENUINE stop() (not a restart) still publishes the down state', async () => {
    stubPlumbing(hub, async () => undefined);
    await hub.start(0);
    setWebUiUp(true);

    const clearSteering = vi.spyOn(hub as unknown as { clearSteering(): void }, 'clearSteering');

    // The real stop(): no sockets are bound (startStack is stubbed), so this
    // must complete and publish `false`.
    await hub.stop(true);

    expect(isWebUiUp()).toBe(false);
    // The steering wipe and the down-publish share the SAME recycle predicate
    // (serve-lifecycle.ts "Both predicates read the SAME flag through one
    // method"). A terminal stop must run BOTH; the recycle path runs NEITHER.
    expect(clearSteering, 'a terminal stop wipes the steering queue').toHaveBeenCalledTimes(1);
  });

  it('a recycle wipes NEITHER seam (steering and down-publish agree)', async () => {
    stubPlumbing(hub, async () => undefined);
    await hub.start(0);
    setWebUiUp(true);

    const clearSteering = vi.spyOn(hub as unknown as { clearSteering(): void }, 'clearSteering');
    getSteeringManager().addNote('survives the recycle');

    await hub.restartServe();

    expect(clearSteering, 'a recycle must not wipe notes — 重启 preserves them').not.toHaveBeenCalled();
    expect(getSteeringManager().isNonEmpty(), 'the note is still queued').toBe(true);
    expect(isWebUiUp()).toBe(true);
  });

  /**
   * SOURCE-TEXT DRIFT GUARD (issue #10 rewrite).
   *
   * WHAT WAS WRONG BEFORE:
   *  1. `expect(downLines.length).toBe(1)` was asserted TWICE on the same array
   *     (`setWebUiUp(false)` literals in serve-lifecycle.ts). Deleting one left
   *     the guard looking intact while halving what it constrained.
   *  2. That literal does not exist in serve-lifecycle.ts AT ALL — the only
   *     occurrences are inside COMMENTS (the LifecycleHost doc lines). The
   *     count was 1 because the comment was counted, so the guard pinned PROSE.
   *     It is 0 once comments are stripped, which is what this test does now.
   *  3. `expect(/if \(!this\.state\.restarting\) this\.host\.publishWebUiDown\(\)/.test(stopText)).toBe(false)`
   *     asserted the ABSENCE of a shape that exists nowhere in the file, so it
   *     could never trip — not even when the gate was deleted.
   *
   * WHAT IT PINS NOW (all on comment-stripped, whitespace-normalised code):
   *  - the gate exists, takes the negative polarity, and forwards to the seam;
   *  - `stop()` reaches the seam ONLY through the gate (a direct
   *    `this.host.publishWebUiDown()` inside stop() fails this test);
   *  - the failure branch publishes AFTER `restarting` is cleared and BEFORE
   *    the rethrow (so the gate cannot suppress a failed recycle).
   */
  it('the source gates the down-publish on the recycle flag and keeps exactly one gate call site (drift guard)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'serve', 'serve-lifecycle.ts'), 'utf-8');
    const code = normalise(src);

    // ── The gate itself: shape AND polarity, on real code ──
    const gateIdx = code.indexOf('private publishDownUnlessRecycling(): void {');
    expect(gateIdx, 'the recycle gate exists').toBeGreaterThanOrEqual(0);
    const gateBody = code.slice(gateIdx, code.indexOf('}', code.indexOf('publishWebUiDown();', gateIdx)) + 1);
    expect(gateBody, 'the gate consults the recycle predicate').toContain('if (!this.isRecycling())');
    expect(gateBody, "the gate's condition is the NEGATED predicate").not.toContain('if (this.isRecycling())');
    expect(gateBody, 'the gate forwards to the host seam').toContain('this.host.publishWebUiDown();');

    // ── isRecycling() is the raw flag, not an inversion of it ──
    const recycleIdx = code.indexOf('private isRecycling(): boolean {');
    expect(recycleIdx, 'isRecycling() exists').toBeGreaterThanOrEqual(0);
    const recycleBody = code.slice(recycleIdx, code.indexOf('}', recycleIdx) + 1);
    expect(recycleBody, 'isRecycling() reads the flag plainly').toContain('return this.state.restarting;');
    expect(recycleBody, 'isRecycling() is not an inverted alias').not.toContain('!');

    // ── stop() reaches the seam ONLY through the gate ──
    const stopIdx = code.indexOf('async stop(skipAbortInput = false): Promise<void> {');
    const gracefulIdx = code.indexOf('async gracefulShutdown(): Promise<void> {');
    expect(stopIdx, 'stop() found').toBeGreaterThanOrEqual(0);
    expect(gracefulIdx, 'gracefulShutdown() found — the stop() body boundary').toBeGreaterThan(stopIdx);
    const stopBody = code.slice(stopIdx, gracefulIdx);
    expect(stopBody, 'stop() publishes down via the gate').toContain('this.publishDownUnlessRecycling();');
    // THE FAILABLE NEGATIVE: a "delete the gate" edit inlines the seam here.
    expect(stopBody, 'stop() never calls the seam directly (no ungated down)').not.toContain(
      'this.host.publishWebUiDown()'
    );
    // And the steering wipe takes the same predicate (one statement of intent).
    expect(stopBody, 'the steering wipe is behind the same predicate').toContain(
      'if (!this.isRecycling()) { this.host.clearSteering(); }'
    );

    // ── The failure branch publishes down, after the flag clears, before the throw ──
    const runRecycleIdx = code.indexOf('private async runRecycle(');
    expect(runRecycleIdx, 'runRecycle() exists').toBeGreaterThan(stopIdx);
    const runRecycleBody = code.slice(runRecycleIdx);
    const flagClear = runRecycleBody.indexOf('this.state.restarting = false;');
    const failBranch = runRecycleBody.indexOf('if (failure !== null) {');
    expect(flagClear, 'restarting is cleared in the finally').toBeGreaterThanOrEqual(0);
    expect(failBranch, 'the failure branch exists').toBeGreaterThan(flagClear);
    const failureBody = runRecycleBody.slice(failBranch);
    const failDown = failureBody.indexOf('this.host.publishWebUiDown();');
    const failThrow = failureBody.indexOf('throw failure;');
    expect(failDown, 'the failure path publishes the down state').toBeGreaterThanOrEqual(0);
    expect(failThrow, 'the failure path rethrows').toBeGreaterThan(failDown);
    expect(failureBody, 'the failure path also settles the input wait').toContain('this.host.abortInput();');

    // ── Exactly two seam calls in the module, at exactly those two sites ──
    // (de-duplicated from the old pair of identical `downLines.length` checks:
    // one assertion, and it now states WHICH two call sites are allowed.)
    const seamCalls = code.split('this.host.publishWebUiDown()').length - 1;
    expect(seamCalls, 'exactly two seam call sites: the gate and the failure branch').toBe(2);
  });
});
