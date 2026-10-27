/**
 * resolve-guard.ts - "was the steering resolve actually DELIVERED?"
 *
 * THE BUG THIS PREVENTS (the "boomerang")
 * --------------------------------------
 * `resolveSteering(sendIds)` used to clear the review card optimistically and
 * fire-and-forget the `steer-resolve` frame. A dropped socket made that send a
 * silent no-op while the BACKEND still held every queued note — so on the next
 * `/history` + `prompt` the notes came back, the user was shown the same card
 * again, and an already-received instruction could be submitted TWICE.
 *
 * THE RULE
 * --------
 * A resolve stays UNCONFIRMED until the server acknowledges it. The only
 * acknowledgement that means "your resolve reached the queue" is the
 * `steer-flush` broadcast the backend emits when it drains. Nothing weaker
 * counts:
 *   - a successful `ws.send()` proves the socket accepted BYTES, not that the
 *     server drained anything;
 *   - a `prompt` means the turn ended — it DISARMS the guard (the buffer it
 *     would have restored is gone) but does NOT confirm delivery.
 *
 * So the guard is deliberately tiny and pure: no timers, no sockets, no store.
 * `main.ts` owns the I/O (snapshot the notes before clearing, restore them if
 * the send threw, force `historyDirty` so the next /history is not a 304) and
 * asks this module whether a resolve is outstanding.
 */

/** What the caller needs to restore when a resolve did not get delivered. */
export interface PendingResolveSnapshot<T> {
  /** The notes the user was reviewing when they resolved (order preserved). */
  notes: T[];
  /** The sendIds that were submitted, kept for a retry/debug trace. */
  sendIds: number[];
}

export interface ResolveGuardState<T> {
  /** The outstanding resolve, or null when the review surface is settled. */
  pending: PendingResolveSnapshot<T> | null;
}

/** Fresh, settled state. */
export function createResolveGuard<T>(): ResolveGuardState<T> {
  return { pending: null };
}

/**
 * Record the review surface BEFORE clearing it, so an undelivered resolve can
 * put the card back exactly as the user saw it.
 *
 * Idempotent overwrite: a second resolve before any acknowledgement replaces
 * the snapshot (the user's latest intent wins; the older card is already gone
 * from the view).
 */
export function armResolve<T>(
  state: ResolveGuardState<T>,
  notes: readonly T[],
  sendIds: readonly number[],
): void {
  state.pending = { notes: [...notes], sendIds: [...sendIds] };
}

/**
 * The server drained the steering queue (`steer-flush`): the resolve was
 * delivered. Disarm.
 *
 * @returns true when a resolve was actually outstanding (so the caller can
 *   skip redundant work when a flush arrives with nothing pending).
 */
export function confirmResolve<T>(state: ResolveGuardState<T>): boolean {
  if (!state.pending) return false;
  state.pending = null;
  return true;
}

/**
 * A `prompt` arrived: the turn ended, so the notes this snapshot held are no
 * longer restorable state (the backend's buffer for them is gone too).
 *
 * Disarm WITHOUT treating it as confirmation — callers must still force a fresh
 * /history, because a prompt does not prove the drain reached the server.
 *
 * @returns true when a resolve was outstanding.
 */
export function disarmResolve<T>(state: ResolveGuardState<T>): boolean {
  if (!state.pending) return false;
  state.pending = null;
  return true;
}

/**
 * The send THREW (socket already closing, etc.). Hand back the snapshot and
 * disarm, so the caller can restore the review card instead of leaving the user
 * with a card that silently vanished while the backend still holds the notes.
 *
 * @returns the snapshot to restore, or null when nothing was outstanding.
 */
export function rollbackResolve<T>(state: ResolveGuardState<T>): PendingResolveSnapshot<T> | null {
  const snapshot = state.pending;
  state.pending = null;
  return snapshot;
}

/** Whether a resolve is still waiting for its `steer-flush` acknowledgement. */
export function isResolvePending<T>(state: ResolveGuardState<T>): boolean {
  return state.pending !== null;
}
