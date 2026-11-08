/**
 * turn-watchdog.ts - The teammate's per-turn deadline, composed with process
 * cancellation.
 *
 * WHY IT LIVES HERE (and not inline in teammate-worker.ts)
 * --------------------------------------------------------
 * The worker module installs process-level handlers (message, SIGTERM, …) on
 * import, so a test cannot import it to reach an inline helper. Extracting the
 * watchdog makes the piece that matters — "does a lead-initiated shutdown
 * interrupt an in-flight LLM turn?" — directly testable with a 1ms cap and no
 * IPC channel.
 *
 * TWO ABORT SOURCES, ONE SIGNAL
 * -----------------------------
 *   deadline (this turn ran too long)  -> retryChat/compact report a STUCK turn
 *   process token (lead is removing us) -> unwind cooperatively, no WARNING
 *
 * They must stay distinguishable, which is why `cause()` exists: both surface
 * downstream as the same abort, and only the watchdog case may mail a WARNING
 * and `continue`.
 */

import { getProcessSignal } from '../loop/cancel-token.js';

export interface TurnWatchdog {
  signal: AbortSignal;
  clearTimeout: () => void;
  deadlineMs: number;
  /**
   * Why the signal fired: 'watchdog' when THIS turn exceeded its deadline,
   * 'shutdown' when the process cancel token fired (lead teardown).
   */
  cause: () => 'watchdog' | 'shutdown';
}

/**
 * Build a turn watchdog.
 *
 * @param budgetFraction - share of the remaining ETA budget a single turn may use
 * @param fallbackMs - cap when no ETA budget is known
 * @param minMs - floor, so a nearly-exhausted budget still allows progress
 * @param remainingBudgetMs - remaining ETA in ms, or Infinity when unknown
 */
export function composeTurnWatchdog(
  budgetFraction: number,
  fallbackMs: number,
  minMs: number,
  remainingBudgetMs = Infinity
): TurnWatchdog {
  const remaining = Number.isFinite(remainingBudgetMs) ? Math.max(0, remainingBudgetMs) : Infinity;

  // Per-turn cap: a fraction of the remaining budget, bounded to [min, fallback].
  const cap = Number.isFinite(remaining)
    ? Math.max(Math.min(remaining * budgetFraction, fallbackMs), minMs)
    : fallbackMs;

  const controller = new AbortController();
  let watchdogFired = false;
  const deadline = Date.now() + cap;
  const timer = setTimeout(() => {
    watchdogFired = true;
    controller.abort('turn watchdog deadline exceeded');
  }, cap);

  // unref so the timer never keeps the worker process alive on its own
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }

  // Compose with process cancellation. Without this the IPC 'shutdown' aborted
  // in-flight TOOLS but left an in-flight LLM turn (or compact summarization)
  // running to its own deadline — so a teammate being removed could sit in a
  // multi-minute call that nothing could interrupt.
  const processSignal = getProcessSignal();
  const linkProcess = () => controller.abort(processSignal.reason);
  if (processSignal.aborted) linkProcess();
  else processSignal.addEventListener('abort', linkProcess, { once: true });

  return {
    signal: controller.signal,
    clearTimeout: () => {
      clearTimeout(timer);
      // Detach on normal completion too, or every LLM turn leaks a listener on
      // the process token.
      processSignal.removeEventListener('abort', linkProcess);
    },
    deadlineMs: deadline,
    // Order matters: if the deadline fired first this turn is stuck; a process
    // abort that landed first is a shutdown. 'watchdog' wins when both are true
    // because it names the slow call, which is the actionable report.
    cause: () => (watchdogFired || !processSignal.aborted ? 'watchdog' : 'shutdown')
  };
}
