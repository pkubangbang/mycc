/**
 * resolve-guard.ts - "was the steer-resolve actually delivered?" state machine.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * `steer-resolve` is TERMINAL server-side: the backend drains the whole
 * steering queue atomically on receipt. So the client may never infer
 * delivery from `ws.send()` alone — on a HALF-OPEN socket the send succeeds
 * into the void, `wsSend()` reports success (readyState is still OPEN), the
 * notes are already gone from the card, and the next PROMPT brings them back
 * for a second submission. That is the bug 71eb910 set out to fix; the
 * `readyState !== OPEN` check it used cannot see it.
 *
 * The server already broadcasts the positive ack: `steer-flush` fires on both
 * terminal drain paths. So a resolve stays UNCONFIRMED until that ack lands.
 * If it never lands, the caller restores the snapshot and forces an
 * authoritative /history re-read.
 *
 * This file holds ONLY that decision (no DOM, no socket, no store), so it is
 * unit-testable under node — `main.ts` itself is the HMR-persistent entry
 * point and cannot be imported in a test.
 */

/** How long a resolve may stay unacknowledged before we distrust the socket. */
export const RESOLVE_ACK_TIMEOUT_MS = 2500;

export interface PendingResolve<T> {
  /** The snapshot to restore if the ack never arrives. */
  readonly notes: readonly T[];
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ResolveGuardOptions<T> {
  /** Restore the snapshot and force an authoritative re-read. */
  onUnconfirmed(notes: readonly T[]): void;
  /**
   * Re-establish the socket. Injected so the guard does not import main.ts.
   */
  reconnect(): void;
  /** Timer factory — injectable for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
  timeoutMs?: number;
}

export interface ResolveGuard<T> {
  /** Arm (or re-arm) the ack window for a just-sent resolve. */
  arm(notes: readonly T[]): void;
  /** The ack arrived, or the socket is gone — stop waiting. */
  clear(): void;
  /** True while a resolve is awaiting its ack. */
  isPending(): boolean;
  /** Test/observability hook: the currently pending snapshot, if any. */
  pending(): PendingResolve<T> | null;
}

/**
 * Build the guard. Any previous unconfirmed resolve is superseded on `arm` —
 * its notes are contained in the new snapshot by construction (the card is
 * the source of both).
 */
export function createResolveGuard<T>(options: ResolveGuardOptions<T>): ResolveGuard<T> {
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((t) => clearTimeout(t));
  const timeoutMs = options.timeoutMs ?? RESOLVE_ACK_TIMEOUT_MS;

  let pending: PendingResolve<T> | null = null;

  function clear(): void {
    if (!pending) return;
    clearTimeoutFn(pending.timer);
    pending = null;
  }

  function arm(notes: readonly T[]): void {
    clear();
    const timer = setTimeoutFn(() => {
      pending = null;
      // No ack: the resolve is NOT delivered. Re-offering a note the server
      // already drained is impossible (it is gone from the queue), while
      // losing one is silent — so restoring is the safe direction.
      options.onUnconfirmed(notes);
      options.reconnect();
    }, timeoutMs);
    pending = { notes, timer };
  }

  return {
    arm,
    clear,
    isPending: () => pending !== null,
    pending: () => pending,
  };
}

/**
 * The socket handler's decision: does this inbound message confirm a pending
 * resolve?
 *
 * `steer-flush` is the ack (server drained the queue). A `prompt` is also
 * terminal for the queue — the backend re-populates the review card from it —
 * so it disarms too, otherwise a slow ack would trigger a spurious restore
 * AFTER the card was already rebuilt.
 */
export function isResolveAck(messageType: string): boolean {
  return messageType === 'steer-flush' || messageType === 'prompt';
}
