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
 * Was a snapshot row already on screen before this snapshot was adopted?
 *
 * The watermark alone cannot answer this: it is a HIGH-WATER mark, so
 * `seq <= cursor` is true for every row of a log the page has been following —
 * the overlap between a snapshot and what the page already rendered is not "at
 * or below the cursor", it is "the page already holds this exact seq". A second
 * reader of the same cursor therefore needs the row set: `already` is the seqs
 * present in the live log before the snapshot was merged.
 *
 * The distinction matters in one concrete place: a row this page rendered from
 * a LIVE frame is in `already`, and if that frame arrived while the snapshot was
 * still in flight, `mergeSnapshot` re-appends it only when it outran the
 * snapshot's maximum. Counting it as "new" makes a caller re-append what the
 * merge already carried — the duplicated bubble.
 */
export function wasRenderedBefore(
  snapshotRow: { seq?: number },
  cursor: number,
  already: ReadonlySet<number>
): boolean {
  const seq = snapshotRow.seq;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return true; // no identity — never a "new" row
  return seq <= cursor && already.has(seq);
}

/**
 * Did the LAST `/clear` remove this row?
 *
 * `clearBoundarySeq` comes from the `/history` payload (`computeClearBoundarySeq`
 * in serve-history.ts), computed from the SAME `lastClearIndex` cut the body
 * already reflects: every record at or below it was cleared away, and every
 * post-clear row carries a strictly higher `seq` (the marker consumed one).
 *
 * WHY A SERVER-STATED BOUNDARY AND NOT A PAGE-LOCAL EPOCH: the old gate compared
 * against `lastRenderedSeq` captured when the live `clear-history` frame
 * arrived. A page that never saw that frame — a SECOND TAB, a sleeping tab, a
 * page reloaded after the clear, anything that HYDRATED from IndexedDB — had no
 * epoch at all, so it re-adopted the whole cleared conversation from its own
 * stale snapshot and wrote it back to the cache: the resurrection was sticky.
 * A boundary that arrives WITH every snapshot survives hydration by
 * construction.
 *
 * `<= 0` means "no clear stated" (or a transcript with no seqs) — nothing is
 * ever cleared, which keeps the pre-clear behaviour for older servers.
 */
export function isClearedByBoundary(seq: number | undefined, clearBoundarySeq: number): boolean {
  if (!(clearBoundarySeq > 0)) return false;
  return typeof seq === 'number' && Number.isFinite(seq) && seq <= clearBoundarySeq;
}

/**
 * Drop every row the last `/clear` removed.
 *
 * Applied to BOTH sides of the snapshot merge — the incoming body and the live
 * tail already in the store — because either side can carry pre-boundary rows: a
 * stale hydrated snapshot (the BLOCKER) on the live side, and a body read before
 * the boundary on the other. Filtering both makes "cleared" a property of the
 * row rather than of which path it arrived on, so there is no epoch left to get
 * out of step with the server.
 *
 * Rows without a `seq` are KEPT: they carry no journal position, so the boundary
 * says nothing about them, and dropping them would silently delete content the
 * server never cut (a legacy row, a serve-lifetime fallback row).
 */
export function withoutClearedRows<T extends { seq?: number }>(rows: readonly T[], clearBoundarySeq: number): T[] {
  if (!(clearBoundarySeq > 0)) return [...rows];
  return rows.filter((m) => !isClearedByBoundary(m.seq, clearBoundarySeq));
}

/**
 * ADOPT a `/history` snapshot: filter the last `/clear` out of BOTH sides, then
 * merge the live tail.
 *
 * This is the ONE decision `fetchHistory` makes, extracted so the test suite can
 * drive the production code path instead of re-implementing it (a lookalike test
 * keeps passing while production drifts).
 *
 * WHY BOTH SIDES: `live` is the store's CURRENT rows. A page that hydrated from
 * IndexedDB — a second tab, a sleeping tab, a page reopened after the clear —
 * holds the PRE-clear conversation there, and it never received the
 * `clear-history` frame, so nothing else tells it those rows are gone. Filtering
 * only the incoming body leaves the stale rows to be re-appended as "the live
 * tail" by {@link mergeSnapshot}, and the next persist writes them back to the
 * cache: the resurrection is sticky. This function is where the BLOCKER dies.
 *
 * @param snapshot     the /history body rows, already stripped of non-chat types
 * @param live         the rows currently in the store
 * @param boundarySeq  `clearBoundarySeq` from the payload (0 = no clear stated)
 * @returns the rows to install, in render order
 */
export function adoptSnapshot<T extends { seq?: number }>(
  snapshot: readonly T[],
  live: readonly T[],
  boundarySeq: number
): T[] {
  const snapshotRows = withoutClearedRows(snapshot, boundarySeq);
  const liveRows = withoutClearedRows(live, boundarySeq);
  return mergeSnapshot(snapshotRows, liveRows);
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
 * THE ONE EXCEPTION IS A CLEAR: the projection DOES cut there now, so this merge
 * is only sound once the cleared rows are gone from BOTH sides. Callers must
 * filter with {@link withoutClearedRows} FIRST, using the snapshot's
 * `clearBoundarySeq` — a pre-clear row is not a "live tail the snapshot lacks",
 * and re-appending it is exactly the resurrection this merge used to cause.
 *
 * @returns the snapshot rows followed by the outran live rows, in live order
 */
export function mergeSnapshot<T extends { seq?: number }>(snapshot: readonly T[], live: readonly T[]): T[] {
  let snapshotMax = 0;
  for (const m of snapshot) {
    const seq = m.seq;
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > snapshotMax) snapshotMax = seq;
  }
  // Dedupe by seq: a row can legitimately appear in BOTH the snapshot and the
  // live tail — a live frame rendered while the 200 was in flight, for a record
  // the snapshot already contained, leaves the same seq on both sides. Keeping
  // both drew the same bubble twice (identical id, timestamp and seq). The
  // snapshot copy wins (it is the body the server just produced); a live row is
  // appended only when the snapshot does not already carry its seq.
  const seen = new Set<number>();
  for (const m of snapshot) {
    if (typeof m.seq === 'number' && Number.isFinite(m.seq)) seen.add(m.seq);
  }
  const outran = live.filter((m) => {
    const seq = m.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return false;
    if (seq <= snapshotMax || seen.has(seq)) return false;
    seen.add(seq); // guard against a live row repeated within the tail itself
    return true;
  });
  return [...snapshot, ...outran];
}
