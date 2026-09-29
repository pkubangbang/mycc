/**
 * transcript.test.ts - unit tests for the append-only piece log read core
 *
 * The {A, AB} regression guard at the transcript layer: every producer call
 * that APPENDS writes exactly ONE flat line; a call that merely MUTATES a
 * message (the user()/note() combine branches) emits a 'merge' piece for the
 * FRAGMENT — so the transcript never records the grown prefix of an earlier
 * line, and read-time collation replays the appends into the exact livelog
 * shape.
 *
 * Also covers: legacy tolerance (bare-message lines pass through as 'new',
 * zero migration), malformed/partial trailing lines skipped (never throw),
 * the turn_id mismatch anomaly path (piece still folded — the livelog has
 * no other fold target), and a CJK multi-byte round trip (UTF-8, no BOM).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  JsonlTranscriptWriter,
  asAppendablePiece,
  readTranscript,
  collateMessages,
  collateEntries,
  type TranscriptRecord,
} from '../../loop/triologue/transcript.js';

describe('JsonlTranscriptWriter ({A, AB} regression guard)', () => {
  let tmpDir: string;
  let filePath: string;
  let writer: JsonlTranscriptWriter;
  let writeErrors: unknown[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-w-'));
    filePath = path.join(tmpDir, 't.jsonl');
    writeErrors = [];
    writer = new JsonlTranscriptWriter(filePath, (err) => writeErrors.push(err));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes exactly 2 short records for user + merged note — NO prefix duplicate', () => {
    // The old snapshot re-emission recorded: {A}, then {AB} (user A grown by
    // the [HINT] X note) — one GROWN line per mutation. The piece design
    // records: {new, "A"}, {merge, "[HINT] X"} — the fragment only, with a
    // kind stamp instead of a resend.
    writer.append(asAppendablePiece({ role: 'user', content: 'A', kind: 'new', turn_id: 1, user_origin: true }));
    writer.append(asAppendablePiece({ role: 'user', content: '[HINT] X', kind: 'merge', turn_id: 1 }));

    const { records, skippedLines } = readTranscript(filePath);
    expect(skippedLines).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0].content).toBe('A');                       // NOT "AB"
    expect(records[0].kind).toBe('new');                       // NOT a resend
    expect(records[0].user_origin).toBe(true);
    expect(records[1].content).toBe('[HINT] X');
    expect(records[1].kind).toBe('merge');
    // Every record got a timestamp from the writer's single clock.
    for (const r of records) expect(r.timestamp).toBeGreaterThan(0);
    expect(writeErrors).toHaveLength(0);
  });

  it('collation of the {A,AB} guard file yields exactly ONE message "A\n[HINT] X"', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'A', kind: 'new', turn_id: 1, user_origin: true }));
    writer.append(asAppendablePiece({ role: 'user', content: '[HINT] X', kind: 'merge', turn_id: 1 }));

    const { records } = readTranscript(filePath);
    const messages = collateMessages(records);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('A\n[HINT] X');
  });

  it('strips the envelope keys (kind/turn_id/user_origin/timestamp) from collated messages', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'q', kind: 'new', turn_id: 7, user_origin: true }));
    const { records } = readTranscript(filePath);
    const [msg] = collateMessages(records);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('q');
    expect(Object.prototype.hasOwnProperty.call(msg, 'kind')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(msg, 'turn_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(msg, 'user_origin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(msg, 'timestamp')).toBe(false);
  });

  it('append never throws on an unwritable path — the error lands in onError', () => {
    const badPath = path.join(tmpDir, 'no-such-dir', 'x.jsonl');
    const badWriter = new JsonlTranscriptWriter(badPath, (err) => writeErrors.push(err));
    expect(() => badWriter.append(asAppendablePiece({ role: 'user', content: 'x' }))).not.toThrow();
    expect(writeErrors).toHaveLength(1);
  });

  it('round-trips CJK multi-byte content without mojibake', () => {
    writer.append(asAppendablePiece({ role: 'user', content: '修复登录页面的中文乱码问题', kind: 'new', turn_id: 1 }));
    writer.append(asAppendablePiece({ role: 'user', content: '——谢谢', kind: 'merge', turn_id: 1 }));
    const { records } = readTranscript(filePath);
    const messages = collateMessages(records);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('修复登录页面的中文乱码问题\n——谢谢');
  });
});

describe('readTranscript (legacy tolerance + skippers)', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-r-'));
    filePath = path.join(tmpDir, 't.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats legacy bare-message lines as new records (zero migration)', () => {
    // Legacy full-snapshot line: no `kind`, plain {role, content, timestamp}.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', content: 'A', timestamp: 5 }) + '\n' +
      JSON.stringify({ role: 'user', content: 'AB', timestamp: 6 }) + '\n',
      'utf-8',
    );
    const { records, skippedLines } = readTranscript(filePath);
    expect(skippedLines).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0].kind).toBe('new');
    expect(records[0].turn_id).toBe(0);
    expect(records[0].timestamp).toBe(5);
    // Legacy {A, AB} duplicates are NOT deduplicated — preserved on read,
    // identical to the pre-fix read behavior.
    expect(collateMessages(records).map((m) => m.content)).toEqual(['A', 'AB']);
  });

  it('skips malformed and partial trailing lines without throwing', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', content: 'ok', kind: 'new', turn_id: 1, timestamp: 1 }) + '\n' +
      '{"role":"assistant","content":"torn wri\n' +          // torn trailing write
      '{not json at all}\n' +
      '[]\n' +                                               // non-object JSON
      JSON.stringify({ kind: 'future', content: '??' }) + '\n', // unknown kind
      'utf-8',
    );
    const { records, skippedLines } = readTranscript(filePath);
    expect(records.map((r) => r.content)).toEqual(['ok']);
    // Every line that could not be collated counts: torn write, malformed
    // JSON, non-object JSON, unknown kind. skippedLines is observability,
    // so all four skip paths are counted uniformly.
    expect(skippedLines).toBe(4);
  });

  it('returns empty records for a missing/empty file', () => {
    expect(readTranscript(path.join(tmpDir, 'missing.jsonl'))).toEqual({ records: [], skippedLines: 0 });
    fs.writeFileSync(filePath, '', 'utf-8');
    expect(readTranscript(filePath)).toEqual({ records: [], skippedLines: 0 });
  });
});

describe('collate projections', () => {
  const baseRecords = (): TranscriptRecord[] => [
    { role: 'user', content: 'task', kind: 'new', turn_id: 1, user_origin: true, timestamp: 100 },
    { role: 'assistant', content: 'hi', kind: 'new', turn_id: 1, timestamp: 110 },
    { role: 'user', content: '[REMINDER] nudge', kind: 'merge', turn_id: 1, timestamp: 120 },
  ];

  it('collateMessages folds a merge into the last user message', () => {
    // The merge piece arrives after an intervening assistant append (a
    // corrupt ordering the producers cannot emit — combine only fires when
    // the livelog's last message is user-role). The collator recovers by
    // folding onto the nearest earlier user host instead of mangling the
    // sequence with a mid-conversation mutation.
    const messages = collateMessages(baseRecords());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('task\n[REMINDER] nudge');
    expect(messages[1].role).toBe('assistant');
  });

  it('collateEntries keeps the HOST timestamp on a folded user entry', () => {
    const entries = collateEntries(baseRecords());
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe(100); // HOST (user turn start), NOT the merge piece's 120
    expect(entries[0].message.content).toBe('task\n[REMINDER] nudge');
    expect(entries[1].message.role).toBe('assistant');
    expect(entries[1].timestamp).toBe(110);
  });

  it('collateMessages leaves a merge turn_id mismatch as an anomaly but still folds', () => {
    const records = baseRecords();
    // Corrupt the piece turn_id: the fold still happens (the livelog has no
    // other fold target), but the mismatch is detectable via onAnomaly.
    const bad = { ...records[2], turn_id: 99 } as TranscriptRecord;
    const anomalies: string[] = [];
    const messages = collateMessages([...records.slice(0, 2), bad], (a) => anomalies.push(a));
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('task\n[REMINDER] nudge');
    expect(anomalies.some((a) => a.includes('turn_id mismatch'))).toBe(true);
  });

  it('collateEntries surfaces the same anomalies through its own onAnomaly', () => {
    const records = baseRecords();
    const bad = { ...records[2], turn_id: 99 } as TranscriptRecord;
    const anomalies: string[] = [];
    const entries = collateEntries(records.slice(0, 2).concat(bad), (a) => anomalies.push(a));
    expect(entries).toHaveLength(2);
    expect(entries[0].message.content).toBe('task\n[REMINDER] nudge');
    expect(anomalies.some((a) => a.includes('turn_id mismatch'))).toBe(true);
  });

  it('merge onto a non-user host pushes as its own message (defensive)', () => {
    // No user host anywhere in the collated view — the merge cannot fold,
    // so its content is kept as its own message and the anomaly is reported.
    const records: TranscriptRecord[] = [
      { role: 'assistant', content: 'a', kind: 'new', turn_id: 1, timestamp: 1 },
      { role: 'user', content: 'm', kind: 'merge', turn_id: 1, timestamp: 2 },
    ];
    const anomalies: string[] = [];
    const messages = collateMessages(records, (a) => anomalies.push(a));
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(messages[0].content).toBe('a');
    expect(anomalies.some((a) => a.includes('without a user host'))).toBe(true);
  });
});