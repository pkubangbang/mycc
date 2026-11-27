/**
 * sleep.ts - CPU-free synchronous sleep.
 *
 * Why this exists: mycc has several SYNCHRONOUS callers (an acquire/poll loop,
 * a rename-retry backoff, a PID-death wait in a CLI) that must wait for a short
 * time without yielding to the event loop — they are ordinary synchronous
 * functions, and making them async would ripple through every caller.
 *
 * A `while (Date.now() < end) {}` spin satisfies "synchronous" but burns 100%
 * of a core for the whole wait. Measured on node v26.7.0 (Windows): 8 x 25 ms of
 * spinning = 203 ms CPU, while the same wait via {@link sleepSync} = 0 ms CPU
 * with the same wall-clock duration. Blocking-ness and CPU cost are INDEPENDENT
 * axes: {@link sleepSync} blocks the thread exactly as the spin did, it simply
 * parks it instead of racing it.
 *
 * Implementation: one module-level `SharedArrayBuffer` + `Atomics.wait`, whose
 * timeout returns "timed-out" without anybody ever needing to notify it. There
 * is no async, no timer, and no per-call allocation.
 */

/** Single shared cell — `Atomics.wait` only needs a stable Int32Array. */
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * Block the current thread for `ms` milliseconds WITHOUT burning CPU.
 *
 * @param ms Milliseconds to wait. Values <= 0 (and non-finite ones) return
 *   immediately, so callers do not need to guard a zero backoff.
 */
export function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  // The cell is never written, so the expected value 0 always matches and the
  // call only ever returns after the timeout ("timed out").
  Atomics.wait(WAIT_CELL, 0, 0, ms);
}
