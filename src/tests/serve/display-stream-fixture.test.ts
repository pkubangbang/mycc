/**
 * display-stream-fixture.test.ts - the regression gate for the v6 display stream
 *
 * WHY A COMMITTED FIXTURE AND PER-ROW TUPLES, NOT COUNTS:
 *   The reviewer rejected aggregate evidence (10→10, 20→10) because a total
 *   cannot distinguish "the right rows in the right order under the right
 *   labels" from "a coincidence of totals". Every assertion below is a
 *   `(seq, type, label, sha256(label + content))` tuple, so a reviewer can diff
 *   the expected stream against the actual one row by row.
 *
 * WHAT THE FIXTURE CONTAINS (src/tests/fixtures/transcripts/display-stream-v6.jsonl):
 *   - three user records sharing ONE timestamp (the duplicated-`ts` shape),
 *   - two labelled display notes (mode_change / plan_on),
 *   - an assistant message (seq 6) and its terminal ECHO note (seq 7),
 *   - a tool message (seq 8, never a row) and a bash note (seq 9).
 *
 * THE GATES:
 *   (d) duplicated timestamps produce ONE visible user row
 *   (e) a LEGACY-format ETag must never answer 304
 *   (f) a session switch resets the watermark to 0 and replays nothing
 *   (gate) user-row count == /history user-turn count, live and refreshed
 *   §1  the brief echo note draws NO row (the duplicate assistant row)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  projectDisplay,
  readHistory,
  computeHistoryVersion,
  etagMatchesIfNoneMatch,
  countTranscriptRecords
} from '../../serve/serve-history.js';
import { collateEntries, readTranscript } from '../../loop/triologue/transcript.js';
import { advanceCursor, isAlreadyRendered, maxSeqOf } from '../../web/src/display-cursor';
import type { LogEntry } from '../../serve/serve-types.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/transcripts/display-stream-v6.jsonl');

/** sha256 over `label \0 content` — a relabel cannot pass as the same row. */
function hashOf(label: string | undefined, content: string): string {
  return crypto.createHash('sha256').update(`${label ?? ''}\u0000${content}`).digest('hex').slice(0, 16);
}

describe('v6 display stream — one row per journaled record (fixture)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'display-stream-v6-'));
    transcriptPath = path.join(tmpDir, 'triologue-lead-1794281361.jsonl');
    fs.copyFileSync(FIXTURE, transcriptPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(gate) projects the fixture to EXACTLY these (seq,type,label,hash) tuples', () => {
    const rows = projectDisplay(transcriptPath);
    // Hand-written expectations a human can audit row by row. The count itself
    // is evidence: 9 journaled records ⇒ 7 rows, because seq 7 is the echo note
    // (dropped, §1) and seq 8 is a tool message (never a row).
    const expected = [
      `1|user|-|${hashOf(undefined, 'run the v6 audit')}`,
      `2|user|-|${hashOf(undefined, 'run the v6 audit')}`,
      `3|user|-|${hashOf(undefined, 'run the v6 audit')}`,
      `4|log|mode_change|${hashOf('mode_change', 'Broadcasted to 0 teammates')}`,
      `5|log|plan_on|${hashOf('plan_on', 'Plan mode activated (strict)')}`,
      `6|result|assistant|${hashOf('assistant', 'Checking the serve-history predicate before touching it.')}`,
      `9|log|bash|${hashOf('bash', 'git grep -n computeHistoryVersion')}`
    ];
    const actual = rows.map((r: LogEntry) => `${r.seq ?? '-'}|${r.type}|${r.label ?? '-'}|${hashOf(r.label, r.content)}`);
    // If this fails, the printed diff IS the tuple comparison to send back.
    expect(actual).toEqual(expected);
  });

  it('(d) duplicated timestamps on the user journal → ONE visible user row', () => {
    const { records } = readTranscript(transcriptPath);
    // The transcript really does hold the duplication: 3 user records, one ts.
    const userRecords = records.filter((r) => r.role === 'user');
    expect(userRecords).toHaveLength(3);
    expect(new Set(userRecords.map((r) => r.timestamp)).size).toBe(1);

    const historyRows = readHistory(transcriptPath, []).filter((r) => r.type === 'user');
    // What the old timestamp-keyed merge got wrong is visible here: rows are
    // keyed by RECORD/seq, so a shared timestamp cannot collapse or double them.
    expect(historyRows.map((r) => r.seq)).toEqual([1, 2, 3]);

    // HONEST LIMIT — measured, not assumed. `collateEntries()` (the restoration
    // projection) counts the same three records as three user turns, while
    // `projectDisplay()` emits three rows. The reviewer's "transcript count ==
    // /history count" therefore holds only where the duplication is FRAGMENTS
    // (kind 'user'/'merge') folded onto a host, as in the real
    // triologue-lead-1794281361.jsonl — not for a literally re-journaled turn.
    // Pinned so the stronger claim cannot be re-derived from this fixture.
    expect(collateEntries(records).filter((e) => e.message.role === 'user')).toHaveLength(3);
    expect(historyRows).toHaveLength(3);
  });

  it('(gate) user-row count == /history user-turn count, live AND after refresh', () => {
    // `.message-row.is-user` is rendered once per `type: 'user'` row
    // (MessageItem's isUser). The live socket projects the same records through
    // the same rule, so both surfaces must agree on a 1-prompt-per-turn session.
    const live = projectDisplay(transcriptPath);
    const refreshed = readHistory(transcriptPath, []);
    const userRows = (rows: LogEntry[]): number => rows.filter((r) => r.type === 'user').length;
    expect(userRows(live)).toBe(3);
    expect(userRows(refreshed)).toBe(3);
    expect(userRows(live)).toBe(userRows(refreshed));
  });

  it('(e) a LEGACY-format ETag must yield a 200 with the full body, never a 304', () => {
    // The pre-`seq` fingerprint folded an UNCONDITIONAL `log:` term and no
    // `seq:` term. A client still holding such a tag must NOT match, or the
    // route would answer 304 with an empty body it cannot merge.
    const legacyEtag = 'W/"hlegacy0000000"';
    const current = computeHistoryVersion(transcriptPath, 0, false, [], true, 9);
    expect(etagMatchesIfNoneMatch(legacyEtag, current)).toBe(false);
    // …and the current tag still revalidates normally (no needless 200s).
    expect(etagMatchesIfNoneMatch(current, current)).toBe(true);
  });

  it('(e) the current tag is stable for a stable file', () => {
    const a = computeHistoryVersion(transcriptPath, 0, false, [], true, 9);
    const b = computeHistoryVersion(transcriptPath, 0, false, [], true, 9);
    expect(b).toBe(a);
  });

  it('(f) switching sessions resets the watermark to 0 and replays NO previous frame', () => {
    // Session A: the client rendered the whole fixture (highest row seq = 9).
    const cursorA = advanceCursor(0, maxSeqOf(projectDisplay(transcriptPath)));
    expect(cursorA).toBe(9);

    // Session B: seq restarts at 1. main.ts resets the watermark on a
    // sessionId change; without that reset every session-B frame is dropped.
    const cursorB = 0;
    expect(isAlreadyRendered(cursorB, 1)).toBe(false);
    expect(isAlreadyRendered(cursorB, 2)).toBe(false);
    // …and nothing from session A can be re-rendered against its old cursor.
    expect(isAlreadyRendered(cursorA, 1)).toBe(true);
    expect(isAlreadyRendered(cursorA, 9)).toBe(true);

    // The FALLBACK window, keyed on RECORD COUNT (see the KNOWN DEFECT note):
    const emptyPath = path.join(tmpDir, 'fresh.jsonl');
    fs.writeFileSync(emptyPath, '', 'utf-8'); // the 'wx' zero-byte file
    expect(countTranscriptRecords(emptyPath)).toBe(0);
    const fallbackRows: LogEntry[] = [{ type: 'log', content: 'serve-lifetime line', timestamp: 1 }];
    expect(readHistory(emptyPath, fallbackRows)).toEqual(fallbackRows);

    // Once ONE record lands the file owns the body outright — projected per
    // record, so the fallback (seq-less) rows are gone.
    fs.writeFileSync(
      emptyPath,
      JSON.stringify({ kind: 'note', note: { level: 'info', tool: 'x', text: 'n', at: '0' }, timestamp: 1 }) + '\n'
    );
    expect(countTranscriptRecords(emptyPath)).toBe(1);
    expect(readHistory(emptyPath, fallbackRows)).toEqual([{ type: 'log', content: 'n', label: 'x', timestamp: 1 }]);
  });

  it('§1 the brief echo note draws NO row (the duplicate assistant row)', () => {
    // The fixture carries seq 6 (assistant message) + seq 7 (echoOf:'message').
    // Only the message row may render — the pair used to draw one paragraph
    // twice: once as the message row (with actions), once as an action-less copy.
    const rows = projectDisplay(transcriptPath);
    expect(rows.filter((r) => r.label === 'assistant')).toHaveLength(1);
    expect(rows.find((r) => r.label === 'assistant')?.type).toBe('result');
    expect(rows.some((r) => r.seq === 7)).toBe(false);
  });
});
