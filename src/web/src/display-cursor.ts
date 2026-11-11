/**
 * display-cursor.ts - the client's journal watermark
 *
 * One number answers the only question the WebUI needs to ask about order:
 * "what have I definitely already rendered?"
 *
 * Every chat row carries the `seq` the transcript writer stamped, on BOTH
 * paths — the /history snapshot and each live socket frame (see
 * JsonlTranscriptWriter and ServeHub.broadcastDisplayRecord, which project the
 * same record). So a page can hold a watermark instead of inventing its own
 * ids, and the overlap between "the snapshot I loaded" and "the frames arriving
 * now" is recognised by identity, not by comparing content or timestamps.
 *
 * Kept pure and DOM-free so the arithmetic is testable in node (see
 * src/tests/web/display-cursor.test.ts); main.ts owns the module-level state and
 * the fetch/socket wiring.
 */

import type { ChatMessage } from './types';

/**
 * Highest journal `seq` in a row set, or 0 when none carry one.
 *
 * Used to adopt a /history snapshot: a 200 replaces the whole visible log, so
 * its maximum IS "everything this page has now rendered". Legacy rows predating
 * the field contribute nothing — they have no identity to compare, and claiming
 * a position for them would let the page believe it had seen records it had not.
 */
export function maxSeqOf(messages: readonly ChatMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (typeof m.seq === 'number' && Number.isFinite(m.seq) && m.seq > max) max = m.seq;
  }
  return max;
}

/**
 * Replace the OLDEST optimistic user echo with the journaled user row.
 *
 * WHY THIS EXISTS: the client pushes a local echo on send (see sendInput), and
 * the server separately journals that submission and broadcasts the row back
 * carrying a `seq`. Those are the same submission, but the cursor gate cannot
 * dedupe them — the local echo has no journal identity to compare. So the sender
 * rendered their own prompt twice. Found by a real-machine run, not by any unit
 * test: every unit test drives one side or the other, never both.
 *
 * Rule: the journaled row WINS (it is the durable copy, and the one /history
 * replays) and it takes the oldest echo's POSITION, so the line does not jump
 * down the log. Only user rows are eligible — an assistant reply can never be the
 * echo of a user submission.
 *
 * @param messages - the current chat rows, in render order
 * @param incoming - a row just received from the socket
 * @returns the new array, or null when there is nothing to reconcile (the caller
 *          then appends normally)
 */
export function reconcileOptimisticUserRow<T extends { type: string; optimistic?: boolean }>(
  messages: readonly T[],
  incoming: T
): T[] | null {
  if (incoming.type !== 'user') return null;
  if (incoming.optimistic === true) return null; // an echo cannot reconcile an echo
  const echoIndex = messages.findIndex((m) => m.optimistic === true);
  if (echoIndex < 0) return null; // no pending echo — normal append
  const next = [...messages];
  next.splice(echoIndex, 1, incoming);
  return next;
}

/**
 * Advance the watermark with a live frame's `seq` — MONOTONIC.
 *
 * Never rewinds, because delivery order is not guaranteed relative to the
 * snapshot: a frame for a record the snapshot already contained arrives after
 * the snapshot adopted its seq. Rewinding would make the next comparison see a
 * "gap" that does not exist and re-fetch on every socket open. A frame with no
 * usable `seq` (a prompt/steering/mode/running state frame, or a malformed one)
 * is not a journal position and leaves the cursor alone.
 */
export function advanceCursor(cursor: number, seq: number | undefined): number {
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= cursor) return cursor;
  return seq;
}

/**
 * Does a live frame still need applying, or is it already rendered?
 *
 * Returns TRUE when the frame carries a journal position at or below the
 * watermark — i.e. the page has that row (it came from the snapshot, or from a
 * frame already applied) and applying it again would duplicate it. A frame with
 * NO seq (prompt / steering / mode / running state) is not a journal position
 * and is always allowed: those frames carry state the watermark says nothing
 * about.
 */
export function isAlreadyRendered(cursor: number, seq: number | undefined): boolean {
  return typeof seq === 'number' && Number.isFinite(seq) && seq <= cursor;
}

/**
 * Merge a /history snapshot with the live frames that outran it.
 *
 * `snapshot` is the body of a 200 read while the socket was already open; frames
 * applied during that round-trip are in `live` but cannot be in `snapshot`.
 * Replacing the log with the snapshot alone would splice the newest rows away.
 *
 * Sound because the projection is pure per record over an append-only stream
 * (see serve-history.ts): every snapshot row is also in `live`, and `live` may
 * hold a tail the snapshot lacks. A row without a seq cannot be positioned
 * against the snapshot — "no seq ⇒ not mine to keep", which keeps this from
 * resurrecting a stale optimistic bubble the server has already reconciled.
 *
 * @returns the snapshot rows followed by the outran live rows, in live order
 */
export function mergeSnapshot<T extends { seq?: number }>(snapshot: readonly T[], live: readonly T[]): T[] {
  let snapshotMax = 0;
  for (const m of snapshot) {
    const seq = m.seq;
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > snapshotMax) snapshotMax = seq;
  }
  const outran = live.filter((m) => {
    const seq = m.seq;
    return typeof seq === 'number' && Number.isFinite(seq) && seq > snapshotMax;
  });
  return [...snapshot, ...outran];
}
