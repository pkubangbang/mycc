/**
 * serve-disconnect-timer.test.ts - 30s disconnect-reconnect timer + persist guard
 *
 * Covers the DisconnectTimer contract added by the serve-persistent Phase 1
 * work (Step 1):
 *   - `start()` short-circuits (never arms the timer) when the `persist`
 *     predicate returns true — so a headless daemon is never killed by the
 *     30 s disconnect-reconnect timer.
 *   - `start()` arms a 30 s timer when persist is false; on timeout it fires
 *     `onGenuineDisconnect`.
 *   - `start()` is idempotent (a second call while counting is a no-op).
 *   - `cancel()` clears a pending timer so `onGenuineDisconnect` never fires.
 *
 * The suspend/hibernate detection path depends on process.hrtime/cpuUsage
 * skew that is impractical to fake reliably here, so it is NOT asserted
 * (would need hrtime injection and is CI-fragile). The persist-guard and the
 * genuine-disconnect fire are the regression-critical contracts.
 *
 * Uses fake timers so the 30 s budget does not stall the test suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock agentIO before importing the module under test — serve-disconnect-timer
// imports agentIO only for the suspend-detection verbose log, which we do not
// exercise here, but the import must resolve.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), brief: vi.fn(), exec: vi.fn() },
}));

import { DisconnectTimer } from '../../serve/serve-disconnect-timer.js';

describe('DisconnectTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never arms when the persist predicate is true', () => {
    const onGenuineDisconnect = vi.fn();
    const onSuspend = vi.fn();
    const timer = new DisconnectTimer(
      { onGenuineDisconnect, onSuspend },
      () => true, // persistent
    );

    timer.start();
    // Advance well past the 30 s budget — nothing should fire.
    vi.advanceTimersByTime(60_000);
    expect(onGenuineDisconnect).not.toHaveBeenCalled();
    expect(onSuspend).not.toHaveBeenCalled();
  });

  it('fires onGenuineDisconnect after 30 s when persist is false', () => {
    const onGenuineDisconnect = vi.fn();
    const onSuspend = vi.fn();
    const timer = new DisconnectTimer(
      { onGenuineDisconnect, onSuspend },
      () => false, // not persistent
    );

    timer.start();
    // Just before the budget — no fire yet.
    vi.advanceTimersByTime(29_999);
    expect(onGenuineDisconnect).not.toHaveBeenCalled();
    // Cross the 30 s threshold.
    vi.advanceTimersByTime(1);
    expect(onGenuineDisconnect).toHaveBeenCalledTimes(1);
    expect(onSuspend).not.toHaveBeenCalled();
  });

  it('start() is idempotent — a second call while counting is a no-op', () => {
    const onGenuineDisconnect = vi.fn();
    const timer = new DisconnectTimer(
      { onGenuineDisconnect, onSuspend: vi.fn() },
      () => false,
    );

    timer.start();
    timer.start(); // second call — must NOT reset or arm a duplicate timer
    vi.advanceTimersByTime(30_000);
    // Exactly one fire, not two.
    expect(onGenuineDisconnect).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents onGenuineDisconnect from firing', () => {
    const onGenuineDisconnect = vi.fn();
    const timer = new DisconnectTimer(
      { onGenuineDisconnect, onSuspend: vi.fn() },
      () => false,
    );

    timer.start();
    timer.cancel();
    vi.advanceTimersByTime(60_000);
    expect(onGenuineDisconnect).not.toHaveBeenCalled();
  });

  it('can be re-armed after the timer fires', () => {
    const onGenuineDisconnect = vi.fn();
    const timer = new DisconnectTimer(
      { onGenuineDisconnect, onSuspend: vi.fn() },
      () => false,
    );

    timer.start();
    vi.advanceTimersByTime(30_000);
    expect(onGenuineDisconnect).toHaveBeenCalledTimes(1);

    // Re-arm and fire again — proves the post-fire state is clean.
    timer.start();
    vi.advanceTimersByTime(30_000);
    expect(onGenuineDisconnect).toHaveBeenCalledTimes(2);
  });

  it('reads the persist predicate at arm time, not construction', () => {
    // The predicate is re-evaluated on each start() call, so a process whose
    // persistence state changes (e.g. stdin TTY flipped) is honoured at the
    // moment the timer would arm — not frozen at construction.
    let persistent = false;
    const onGenuineDisconnect = vi.fn();
    const timer = new DisconnectTimer(
      { onGenuineDisconnect, onSuspend: vi.fn() },
      () => persistent,
    );

    // First arm: not persistent → timer arms.
    timer.start();
    // Flip to persistent BEFORE the budget — cancel and re-arm to simulate
    // a fresh disconnect event under the new state.
    persistent = true;
    timer.cancel();
    timer.start();
    vi.advanceTimersByTime(60_000);
    // Persistent now → never fires.
    expect(onGenuineDisconnect).not.toHaveBeenCalled();
  });
});