/**
 * turn-watchdog.test.ts - The peer's final blocking gap: does a lead-initiated
 * shutdown interrupt an in-flight LLM turn (or compact summarization)?
 *
 * Before the fix, createTurnWatchdog handed retryChat/compact a standalone
 * AbortController that only its own deadline could abort. The IPC shutdown then
 * stopped in-flight TOOLS but left a 3-minute LLM call running — so a teammate
 * being removed could not actually be removed promptly, and its catch reported
 * a "stuck turn" WARNING about a turn that was not stuck at all.
 *
 * These tests drive the real composition with a 1ms cap/floor so no timer ever
 * dominates the suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

async function load() {
  vi.resetModules();
  const watchdog = await import('../../context/turn-watchdog.js');
  const token = await import('../../loop/cancel-token.js');
  return { ...watchdog, ...token };
}

describe('turn watchdog composed with process cancellation', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('aborts on the deadline with cause "watchdog"', async () => {
    const { composeTurnWatchdog } = await load();
    const w = composeTurnWatchdog(0.5, 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(w.signal.aborted).toBe(true);
    expect(w.cause()).toBe('watchdog');
    w.clearTimeout();
  });

  it('aborts IMMEDIATELY when the process token fires, with cause "shutdown"', async () => {
    const { composeTurnWatchdog, cancelProcess } = await load();
    // Long deadline: only the process token can be responsible for this abort.
    const w = composeTurnWatchdog(0.5, 60_000, 60_000);
    expect(w.signal.aborted).toBe(false);
    cancelProcess('test teardown');
    expect(w.signal.aborted).toBe(true);
    expect(w.cause()).toBe('shutdown');
    w.clearTimeout();
  });

  it('is already aborted when composed after cancellation', async () => {
    const { composeTurnWatchdog, cancelProcess } = await load();
    cancelProcess();
    const w = composeTurnWatchdog(0.5, 60_000, 60_000);
    expect(w.signal.aborted).toBe(true);
    expect(w.cause()).toBe('shutdown');
    w.clearTimeout();
  });

  it('clearTimeout detaches the process listener (no leak across turns)', async () => {
    const { composeTurnWatchdog, processCancelListenerCount } = await load();
    const baseline = processCancelListenerCount();
    for (let i = 0; i < 20; i++) {
      composeTurnWatchdog(0.5, 5, 5).clearTimeout();
    }
    expect(processCancelListenerCount()).toBe(baseline);
  });

  it('reports "watchdog" when the deadline and a late cancellation coincide', async () => {
    const { composeTurnWatchdog, cancelProcess } = await load();
    const w = composeTurnWatchdog(0.5, 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    cancelProcess();
    // The slow call is the actionable fact, so the watchdog reason wins.
    expect(w.cause()).toBe('watchdog');
    w.clearTimeout();
  });
});
