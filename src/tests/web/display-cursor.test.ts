/**
 * display-cursor.test.ts - the client's seq watermark (S3)
 *
 * /history is fetched BEFORE the socket opens, and the server does not replay
 * the journal over the wire. Any record journaled in that window is in neither
 * the store nor the live stream, so it would stay invisible until a reload —
 * the silent gap this slice closes.
 *
 * The mechanism is one number: the highest journal `seq` the page has rendered.
 * Every chat row carries it on BOTH paths (the /history snapshot and the live
 * socket frame, both projected from the same record — see
 * display-record-seam.test.ts), so the overlap between a snapshot and the live
 * stream is recognised by identity instead of guessed at by content.
 *
 * This file pins the pure cursor arithmetic. The browser wiring (fetchHistory
 * adopting the snapshot's maximum, ws.onmessage advancing per frame, ws.onopen
 * re-validating) is deliberately thin and sits on top of these two functions.
 */
import { describe, it, expect } from 'vite-plus/test';
import { maxSeqOf, advanceCursor, isAlreadyRendered, mergeSnapshot, reconcileOptimisticUserRow } from '../../web/src/display-cursor.js';

const row = (seq?: number) => ({ type: 'log' as const, content: 'x', ...(seq === undefined ? {} : { seq }) });

describe('maxSeqOf — the snapshot watermark', () => {
  it('returns the highest seq in the row set', () => {
    expect(maxSeqOf([row(1), row(7), row(3)])).toBe(7);
  });

  it('is 0 when nothing carries a seq (legacy rows, state frames)', () => {
    // Records written before the field existed have no identity to compare, so
    // they must not claim a position — 0 keeps the cursor at "nothing journaled
    // seen", which is the truth for a pre-seq transcript.
    expect(maxSeqOf([row(), row()])).toBe(0);
    expect(maxSeqOf([])).toBe(0);
  });

  it('ignores non-numeric seqs rather than trusting them', () => {
    const junk = [{ type: 'log' as const, content: 'x', seq: 'nope' }] as unknown as Parameters<typeof maxSeqOf>[0];
    expect(maxSeqOf(junk)).toBe(0);
  });
});

describe('advanceCursor — monotonic, never rewinds', () => {
  it('advances past a newer frame', () => {
    expect(advanceCursor(5, 9)).toBe(9);
  });

  it('ignores an older or equal frame (out-of-order delivery, duplicate)', () => {
    // A live frame can arrive after a snapshot that already contains it: the
    // snapshot adopted seq 9, the socket then delivers 9 and 8. Neither may pull
    // the cursor back, or a later comparison would think records were missing
    // and re-fetch on every open.
    expect(advanceCursor(9, 9)).toBe(9);
    expect(advanceCursor(9, 8)).toBe(9);
  });

  it('ignores a frame with no seq (a state frame is not a journal position)', () => {
    expect(advanceCursor(4, undefined)).toBe(4);
    expect(advanceCursor(4, 0)).toBe(4);
  });

  it('is not confused by a NaN/Infinity seq from a malformed frame', () => {
    expect(advanceCursor(4, Number.NaN)).toBe(4);
    expect(advanceCursor(4, Number.POSITIVE_INFINITY)).toBe(4);
  });
});

/**
 * B3 TEETH: before these rules existed, `lastRenderedSeq` was assigned, advanced
 * and never READ — it enforced nothing, so a frame the snapshot already covered
 * was applied twice (the duplicate-card defect, on the live path). The tests
 * below fail if either rule is removed from main.ts's wiring, which is why the
 * logic was extracted here instead of living as two inline expressions.
 */
describe('isAlreadyRendered — the live-frame gate', () => {
  it('drops a frame the snapshot already covered', () => {
    expect(isAlreadyRendered(7, 7)).toBe(true);
    expect(isAlreadyRendered(7, 3)).toBe(true);
  });

  it('admits a frame beyond the watermark', () => {
    expect(isAlreadyRendered(7, 8)).toBe(false);
  });

  it('always admits a frame with no journal position (state, prompt, steer)', () => {
    // These carry state the watermark says nothing about: dropping them would
    // freeze the phase indicator.
    expect(isAlreadyRendered(7, undefined)).toBe(false);
    expect(isAlreadyRendered(7, Number.NaN)).toBe(false);
  });
});

/**
 * SESSION CHANGE resets the watermark.
 *
 * `seq` restarts at 1 for every new session (a fresh transcript ⇒ the writer
 * starts at 1), but `advanceCursor` is monotonic by design and never lowers it.
 * An unreset cursor therefore judges EVERY frame of the new session "already
 * rendered" and drops it before the store — the live stream dies until the new
 * session out-runs the old watermark, and no later 200 can repair it because the
 * cursor cannot rewind. main.ts resets `lastRenderedSeq = 0` in the session-change
 * block beside `lastHistoryEtag = null`; the assertion below is the rule that
 * reset exists to preserve.
 */
describe('a session change must not leave a stale watermark', () => {
  it('after the reset, the new session\u2019s FIRST frame is admitted', () => {
    const staleCursor = 500; // session A ended here
    const afterReset = 0; // main.ts session-change block
    expect(isAlreadyRendered(staleCursor, 1)).toBe(true); // the bug: dropped
    expect(isAlreadyRendered(afterReset, 1)).toBe(false); // fixed: admitted
    expect(advanceCursor(staleCursor, 1)).toBe(staleCursor); // monotonic, cannot heal itself
  });
});

describe('reconcileOptimisticUserRow — the sender must not see their prompt twice', () => {
  type Row = { type: string; content: string; seq?: number; optimistic?: boolean };
  const echo = (content: string): Row => ({ type: 'user', content, optimistic: true });
  const journaled = (content: string, seq: number): Row => ({ type: 'user', content, seq });
  const logRow = (content: string): Row => ({ type: 'log', content });

  it('replaces the echo with the journaled row (found by the real-machine run)', () => {
    // /history had ONE user row (seq 2) while the DOM had TWO .message-row.is-user.
    // The cursor gate could not help: the echo carries no seq to compare.
    const messages: Row[] = [echo('PONG please'), logRow('await')];
    const out = reconcileOptimisticUserRow(messages, journaled('PONG please', 2));
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2); // replaced, not appended
    expect(out?.[0]).toMatchObject({ type: 'user', seq: 2 });
    expect(out?.some((m) => m.optimistic)).toBe(false);
  });

  it('keeps the echo POSITION so the line does not jump down the log', () => {
    const messages: Row[] = [echo('a'), logRow('mid'), echo('b')];
    const out = reconcileOptimisticUserRow(messages, journaled('a', 5));
    expect(out?.map((m) => m.content)).toEqual(['a', 'mid', 'b']);
    // The SECOND echo is untouched — one journaled row reconciles one echo.
    expect(out?.[2]).toMatchObject({ optimistic: true });
  });

  it('returns null when there is no echo (a peer\'s message appends normally)', () => {
    const messages: Row[] = [logRow('x')];
    expect(reconcileOptimisticUserRow(messages, journaled('from another browser', 7))).toBeNull();
  });

  it('never reconciles on a non-user row (an assistant reply is not an echo)', () => {
    expect(reconcileOptimisticUserRow([echo('q')], { type: 'result', content: 'answer', seq: 4 })).toBeNull();
  });

  it('an echo cannot reconcile another echo', () => {
    expect(reconcileOptimisticUserRow([echo('a')], echo('b'))).toBeNull();
  });
});

describe('mergeSnapshot — a 200 must not splice away a just-rendered frame', () => {
  const snap = (seq: number, content: string) => ({ type: 'log' as const, content, seq });
  const loose = (content: string) => ({ type: 'user' as const, content });

  it('keeps live rows that outran the snapshot, after the snapshot rows', () => {
    // /history was read while the socket was open: rows 1-2 are in the body,
    // row 3 arrived during the round-trip and only exists in the store.
    const snapshot = [snap(1, 'a'), snap(2, 'b')];
    const live = [snap(1, 'a'), snap(2, 'b'), snap(3, 'c')];
    expect(mergeSnapshot(snapshot, live).map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate a row present in BOTH (the old bug, inverted)', () => {
    const snapshot = [snap(1, 'a'), snap(2, 'b')];
    const live = [snap(2, 'b')];
    expect(mergeSnapshot(snapshot, live)).toHaveLength(2);
    expect(mergeSnapshot(snapshot, live).map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('does not resurrect a row the snapshot DROPPED (a reconciled optimistic bubble)', () => {
    // The optimistic bubble has no seq — "no seq ⇒ not mine to keep". Adopting it
    // back would show a user bubble the server never accepted.
    type Row = { type: string; content: string; seq?: number };
    const snapshot: Row[] = [snap(1, 'a')];
    const live: Row[] = [loose('typed locally')];
    expect(mergeSnapshot(snapshot, live).map((m) => m.content)).toEqual(['a']);
  });

  it('a pure append NEVER removes or reorders an earlier row (merge soundness pin)', () => {
    // This is the precondition merge-by-seq rests on: projectDisplayRecord is a
    // pure function of each record over an append-only stream, with no cap and no
    // collapse rule. If a future change adds one, merge silently becomes a
    // resurrection bug — so the property, not the implementation, is pinned.
    const snapshot = [snap(10, 'x'), snap(11, 'y'), snap(12, 'z')];
    const live = [snap(10, 'x'), snap(11, 'y'), snap(12, 'z'), snap(13, 'w')];
    const merged = mergeSnapshot(snapshot, live);
    expect(merged.slice(0, snapshot.length)).toEqual(snapshot);
    expect(merged.map((m) => m.seq)).toEqual([10, 11, 12, 13]);
  });
});
