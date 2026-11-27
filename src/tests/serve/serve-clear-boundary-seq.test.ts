/**
 * serve-clear-boundary-seq.test.ts — the `/clear` boundary that SURVIVES HYDRATION
 *
 * The review's only BLOCKER lived here. The old client gate was
 * `snapshotPredatesClear(maxSeqOf(visible), clearedAtSeq)`, where `clearedAtSeq`
 * was a PAGE-LOCAL watermark captured when the live `clear-history` frame
 * arrived. A page that never received that frame — a SECOND TAB, a sleeping tab,
 * a page reopened after the clear, anything that hydrated from IndexedDB — had
 * `clearedAtSeq === null`, so the gate never fired, the pre-clear conversation
 * was re-adopted from its stale snapshot by `mergeSnapshot`, and
 * `persistChatlog()` wrote it back. The resurrection was STICKY.
 *
 * The fix has two halves, and this file covers both:
 *   1. SERVER: `/history` states the boundary (`computeClearBoundarySeq`), so the
 *      number arrives with the payload and cannot be missed by a page that was
 *      asleep. It is derived from the SAME `lastClearIndex` cut the body already
 *      reflects, so body and boundary cannot drift.
 *   2. CLIENT: `adoptSnapshot` filters the boundary out of BOTH sides of the
 *      merge. Filtering the LIVE side is the load-bearing half — the stale rows
 *      live in the store, not in the body. See the mutation note on case (b).
 */
import { describe, it, expect } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonlTranscriptWriter, type ControlPiece } from '../../loop/triologue/transcript.js';
import { computeClearBoundarySeq, readTranscriptRecords } from '../../serve/serve-history.js';
import { adoptSnapshot, withoutClearedRows } from '../../web/src/display-cursor.js';

/** A chat row carrying only the journal identity these functions care about. */
const row = (seq: number) => ({ type: 'log' as const, content: `row-${seq}`, seq });

describe('(a) computeClearBoundarySeq — the boundary /history states', () => {
  let tmpDir: string;
  let writer: JsonlTranscriptWriter;

  const setup = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-boundary-seq-'));
    writer = new JsonlTranscriptWriter(path.join(tmpDir, 'transcript.jsonl'));
  };
  const boundary = (): number => computeClearBoundarySeq(readTranscriptRecords(path.join(tmpDir, 'transcript.jsonl')));

  it('is 0 when the transcript holds no clear', () => {
    setup();
    writer.append({ role: 'user', content: 'q1' });
    expect(boundary()).toBe(0);
  });

  it('is the max seq at/through the ONE marker (inclusive of the cleared region)', () => {
    setup();
    writer.append({ role: 'user', content: 'q1' }); // seq 1
    writer.append({ kind: 'clear' } as ControlPiece); // seq 2
    expect(boundary()).toBe(2);
  });

  it('follows the LAST clear when a session is cleared twice — the higher boundary', () => {
    setup();
    writer.append({ role: 'user', content: 'q1' }); // seq 1
    writer.append({ kind: 'clear' } as ControlPiece); // seq 2
    writer.append({ role: 'user', content: 'q2' }); // seq 3
    writer.append({ kind: 'clear' } as ControlPiece); // seq 4
    expect(boundary()).toBe(4);
  });
});

describe('(b) THE BLOCKER — a page that NEVER saw the clear frame', () => {
  it('does not re-adopt pre-clear rows hydrated into the store', () => {
    // THE SECOND-TAB STATE: the store already holds the cleared conversation,
    // hydrated from IndexedDB. No `clear-history` frame was ever delivered, so
    // nothing has told this page those rows are gone.
    const staleLive = [1, 2, 3, 4].map(row);
    // The server's projection IS cut and nothing was said after the clear, so the
    // body is EMPTY. This shape matters: `mergeSnapshot` only re-appends live rows
    // ABOVE the body's maximum, so an empty body re-admits EVERY stale row — the
    // actual resurrection, and the reason a non-empty body cannot reproduce it.
    const postClearBody: Array<{ type: 'log'; content: string; seq: number }> = [];
    // The marker consumed seq 5, so the boundary is stated as 5.
    const adopted = adoptSnapshot(postClearBody, staleLive, 5);

    expect(adopted).toEqual([]);
    // No pre-clear row survives — the assertion the whole review turns on.
    expect(adopted.some((r) => typeof r.seq === 'number' && r.seq <= 5)).toBe(false);
  });

  it('keeps post-clear rows while still dropping the hydrated pre-clear ones', () => {
    const staleLive = [1, 2, 3, 4].map(row);
    const postClearBody = [6].map(row);
    expect(adoptSnapshot(postClearBody, staleLive, 5).map((r) => r.seq)).toEqual([6]);
  });
});

describe('(c) boundary === 0 — no clear stated, nothing is filtered', () => {
  it('keeps live rows and the body (legacy-server / no-clear regression guard)', () => {
    // Body max (2) is BELOW the live rows (3,4) — the "frames that outran the
    // snapshot" case mergeSnapshot exists for. With no boundary stated both sides
    // survive untouched.
    const live = [3, 4].map(row);
    const body = [1, 2].map(row);
    expect(adoptSnapshot(body, live, 0).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(withoutClearedRows(live, 0)).toHaveLength(2);
  });
});

describe('(d) the boundary edges', () => {
  it('drops a row whose seq EQUALS the boundary, keeps boundary + 1', () => {
    expect(withoutClearedRows([row(5), row(6)], 5).map((r) => r.seq)).toEqual([6]);
    const adopted = adoptSnapshot([row(6)], [row(5)], 5);
    expect(adopted.map((r) => r.seq)).toEqual([6]);
  });
});
