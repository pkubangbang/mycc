/**
 * parent-ipc.ts - Singleton wrapper for IPC messages to the Coordinator.
 *
 * The Lead communicates with its parent Coordinator process via
 * `process.send(message)`. In normal (interactive) mode the Coordinator
 * stays alive and listens; in `--daemon` mode the Coordinator spawns the
 * detached Lead and exits 0 immediately (startDaemonLead → child.unref()
 * → process.exit(0)), so by the time the Lead calls `process.send` the IPC
 * channel is *closed*. The channel object still exists (so `process.send`
 * is truthy), but invoking it throws `ERR_IPC_CHANNEL_CLOSED` — an
 * uncaught synchronous exception that crashed the daemon Lead right after
 * "Web UI started".
 *
 * This module centralizes that knowledge. Every call site that wants to
 * notify the Coordinator should use {@link sendToParent} instead of
 * `process.send` directly: it no-ops when there is no live parent (no
 * channel, or daemon mode where the Coordinator has already exited) and
 * swallows the closed-channel error as a final safety net, so a daemon
 * Lead can never crash on a best-effort IPC notification.
 *
 * What this is NOT: this is for fire-and-forget notifications only. Call
 * sites that send an IPC message and then `await new Promise(() => {})`
 * to wait for the Coordinator to kill them (e.g. /reload, /load's
 * cross-directory restart) MUST still guard with `shouldDaemon()` and
 * early-return FIRST — a no-op send would otherwise leave them hanging
 * forever, since no Coordinator will ever respond. This wrapper cannot
 * fix that hang; it only makes the send itself safe.
 */

import { shouldDaemon } from '../config.js';

/**
 * Best-effort IPC message to the Coordinator parent process.
 *
 * @param message  The IPC message object (must be serializable).
 * @returns `true` if the message was sent, `false` if it was a no-op
 *          (no parent / daemon mode / channel closed).
 */
export function sendToParent(message: unknown): boolean {
  // No IPC channel at all (e.g. tests, or a process spawned without stdio
  // 'ipc'). `process.send` is undefined in that case.
  if (typeof process.send !== 'function') return false;

  // In --daemon mode the Coordinator has already exited, so there is no
  // parent to receive the message. Skip the send entirely — invoking the
  // closed channel would throw ERR_IPC_CHANNEL_CLOSED.
  if (shouldDaemon()) return false;

  try {
    process.send(message);
    return true;
  } catch {
    // Defensive: even outside daemon mode, the channel can close between
    // the truthy check above and the send (e.g. the Coordinator died). A
    // best-effort notification must never crash the Lead. Swallow it.
    return false;
  }
}