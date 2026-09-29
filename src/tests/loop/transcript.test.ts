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
 * The replay invariant is PURELY POSITIONAL (no turn-identity layer):
 *   kind:'new'    → push
 *   kind:'merge'  → fold onto the most recently collated user message
 *                   (single lastUserIndex cursor — O(n) replay)
 *   kind:'clear' | 'compact' | 'recap' | 'rollback'
 *                 → journaled truncation boundary (conflated into kind);
 *                   'clear' RESETS the collated view (restoration honors
 *                   /clear); compact/recap/rollback are markers that keep
 *                   the full history.
 *
 * Also covers: legacy tolerance (bare-message lines pass through as 'new',
 * zero migration), malformed/partial trailing lines skipped (never throw),
 * the structural anomaly path (merge with no user host — content kept as
 * its own message), and a CJK multi-byte round trip (UTF-8, no BOM).
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
    writer.append(asAppendablePiece({ role: 'user', content: 'A', kind: 'new', user_origin: true }));
    writer.append(asAppendablePiece({ role: 'user', content: '[HINT] X', kind: 'merge' }));

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

  it('collation of the {A,AB} guard file yields exactly ONE message "A\\n[HINT] X"', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'A', kind: 'new', user_origin: true }));
    writer.append(asAppendablePiece({ role: 'user', content: '[HINT] X', kind: 'merge' }));

    const { records } = readTranscript(filePath);
    const messages = collateMessages(records);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('A\n[HINT] X');
  });

  it('strips the envelope keys (kind/user_origin/timestamp/event) from collated messages', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'q', kind: 'new', user_origin: true }));
    const { records } = readTranscript(filePath);
    const [msg] = collateMessages(records);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('q');
    expect(Object.prototype.hasOwnProperty.call(msg, 'kind')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(msg, 'user_origin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(msg, 'timestamp')).toBe(false);
  });

  it('append never throws on an unwritable path — the error lands in onError', () => {
    const badPath = path.join(tmpDir, 'no-such-dir', 'x.jsonl');
    const badWriter = new JsonlTranscriptWriter(badPath, (err) => writeErrors.push(err));
    expect(() => badWriter.append(asAppendablePiece({ role: 'user', content: 'x' }))).not.toThrow();
    expect(writeErrors).toHaveLength(1);
  });

  it('an onError callback that THROWS never breaks the writer (never-throws contract)', () => {
    const badWriter = new JsonlTranscriptWriter(
      path.join(tmpDir, 'no-such-dir', 'y.jsonl'),
      () => { throw new Error('oops'); },
    );
    expect(() => badWriter.append(asAppendablePiece({ role: 'user', content: 'x' }))).not.toThrow();
  });

  it('control() journals a bare boundary record {kind:event,timestamp}', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'A', kind: 'new', user_origin: true }));
    writer.control('clear');
    writer.append(asAppendablePiece({ role: 'user', content: 'B', kind: 'new', user_origin: true }));
    const { records, skippedLines } = readTranscript(filePath);
    expect(skippedLines).toBe(0);
    expect(records).toHaveLength(3);
    // The event name IS the kind (conflated — no 'control' pseudo-kind,
    // no separate event field).
    expect(records[1].kind).toBe('clear');
    expect((records[1] as Record<string, unknown>).event).toBeUndefined();
    expect(records[1].timestamp).toBeGreaterThan(0);
    expect(records[1].role).toBeUndefined(); // no message fields on boundary records
  });

  it('round-trips CJK multi-byte content without mojibake', () => {
    writer.append(asAppendablePiece({ role: 'user', content: '修复登录页面的中文乱码问题', kind: 'new', user_origin: true }));
    writer.append(asAppendablePiece({ role: 'user', content: '——谢谢', kind: 'merge' }));
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
    expect(records[0].timestamp).toBe(5);
    // Legacy {A, AB} duplicates are NOT deduplicated — preserved on read,
    // identical to the pre-fix read behavior.
    expect(collateMessages(records).map((m) => m.content)).toEqual(['A', 'AB']);
  });

  it('skips malformed and partial trailing lines without throwing', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', content: 'ok', kind: 'new', timestamp: 1 }) + '\n' +
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

describe('collate projections (positional replay)', () => {
  const baseRecords = (): TranscriptRecord[] => [
    { role: 'user', content: 'task', kind: 'new', user_origin: true, timestamp: 100 },
    { role: 'assistant', content: 'hi', kind: 'new', timestamp: 110 },
    { role: 'user', content: '[REMINDER] nudge', kind: 'merge', timestamp: 120 },
  ];

  it('collateMessages folds a merge into the MOST RECENTLY COLLATED user message (positional)', () => {
    // The merge piece arrives after an intervening assistant append (a
    // corrupt ordering the producers cannot emit — combine only fires when
    // the livelog's last message is user-role). Replay is purely positional:
    // the merge folds onto the most recently collated USER message (the
    // cursor skips the assistant), recovering instead of mangling.
    const messages = collateMessages(baseRecords());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('task\n[REMINDER] nudge');
    expect(messages[1].role).toBe('assistant');
  });

  it('collateEntries is a clean scan: a merge fragment is SKIPPED (never folded)', () => {
    // The serve view does NOT fold — the 'merge' [REMINDER] note is an
    // injected fragment, not a user bubble, so collateEntries drops it and
    // the user host keeps its own bare content.
    const entries = collateEntries(baseRecords());
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe(100); // HOST (user turn start)
    expect(entries[0].message.content).toBe('task');
    expect(entries[1].message.role).toBe('assistant');
    expect(entries[1].timestamp).toBe(110);
  });

  it('merge onto a non-user host pushes as its own message (restoration) and is skipped by the serve view', () => {
    // No user host anywhere in the collated view — the restoration view
    // cannot fold, so its content is kept as its own message and the anomaly
    // is reported. The serve view NEVER renders a merge fragment (it is a
    // note, not a user bubble), so it is skipped there without an anomaly.
    const records: TranscriptRecord[] = [
      { role: 'assistant', content: 'a', kind: 'new', timestamp: 1 },
      { role: 'user', content: 'm', kind: 'merge', timestamp: 2 },
    ];
    const anomalies: string[] = [];
    const messages = collateMessages(records, (a) => anomalies.push(a));
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(messages[0].content).toBe('a');
    expect(anomalies.some((a) => a.includes('without a user host'))).toBe(true);
    const entries = collateEntries(records, (a) => anomalies.push(a));
    expect(entries.map((e) => e.message.role)).toEqual(['assistant']);
  });

  it('replay stays O(n): a merge-heavy transcript folds in one pass', () => {
    // 1 user host + N merges collapse into ONE message without any backward
    // scan per merge (the cursor does the work).
    const records: TranscriptRecord[] = [
      { role: 'user', content: 'q', kind: 'new', user_origin: true, timestamp: 1 },
    ];
    for (let i = 0; i < 500; i++) {
      records.push({ role: 'user', content: `n${i}`, kind: 'merge', timestamp: 2 + i });
    }
    const messages = collateMessages(records);
    expect(messages).toHaveLength(1);
    expect((messages[0].content as string).split('\n')).toHaveLength(501); // q + 500 notes
  });
});

describe('control events (journaled truncation boundaries)', () => {
  let tmpDir: string;
  let filePath: string;
  let writer: JsonlTranscriptWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-c-'));
    filePath = path.join(tmpDir, 't.jsonl');
    writer = new JsonlTranscriptWriter(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('control clear RESETS the collated view (restoration honors /clear)', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'A', kind: 'new', user_origin: true }));
    writer.append(asAppendablePiece({ role: 'assistant', content: 'B', kind: 'new' }));
    writer.control('clear');
    writer.append(asAppendablePiece({ role: 'user', content: 'C', kind: 'new', user_origin: true }));

    const { records } = readTranscript(filePath);
    const messages = collateMessages(records);
    // Pre-clear material does NOT resurrect; the post-clear view starts fresh.
    expect(messages.map((m) => m.content)).toEqual(['C']);
  });

  it('control clear KEEPS the entries projection (archival serve-history view)', () => {
    // Review F2 resolution (b): the serve projection is archival — a clear
    // boundary marker does NOT cut it (only the restoration projection
    // resets). The pre-clear entry must survive so the durable history
    // stays a consistent superset across all serve-history sources.
    writer.append(asAppendablePiece({ role: 'tool', tool_name: 'bash', content: 'old', kind: 'new' } as Record<string, unknown>));
    writer.control('clear');
    writer.append(asAppendablePiece({ role: 'tool', tool_name: 'bash', content: 'new', kind: 'new' } as Record<string, unknown>));
    const { records } = readTranscript(filePath);
    const entries = collateEntries(records);
    expect(entries.map((e) => e.message.content)).toEqual(['old', 'new']);
  });

  it('control events after a merge re-arm the fold cursor (post-clear merge folds onto the post-clear host)', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'old host', kind: 'new', user_origin: true }));
    writer.control('clear');
    writer.append(asAppendablePiece({ role: 'user', content: 'new host', kind: 'new', user_origin: true }));
    writer.append(asAppendablePiece({ role: 'user', content: '[HINT] note', kind: 'merge' }));
    const { records } = readTranscript(filePath);
    const messages = collateMessages(records);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('new host\n[HINT] note');
  });

  it('compact/recap/rollback control events are markers — the collated view is kept (durable full history)', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'q', kind: 'new', user_origin: true }));
    writer.append(asAppendablePiece({ role: 'assistant', content: 'a', kind: 'new' }));
    writer.control('compact');
    writer.append(asAppendablePiece({ role: 'user', content: '[Conversation compressed. ...]', kind: 'new' }));
    writer.control('recap');
    writer.control('rollback');
    writer.append(asAppendablePiece({ role: 'assistant', content: 'r', kind: 'new' }));

    const { records } = readTranscript(filePath);
    const messages = collateMessages(records);
    // Superset semantics: boundary markers never cut the collated history.
    expect(messages.map((m) => m.content)).toEqual(['q', 'a', '[Conversation compressed. ...]', 'r']);
    const anomalies: string[] = [];
    collateMessages(records, (a) => anomalies.push(a));
    expect(anomalies).toHaveLength(0);
    const entries = collateEntries(records);
    // Serve projection: the marked 'q' new-user piece is a bubble, the
    // UNMARKED post-compact summary is not (injected context, not input).
    expect(entries.map((e) => e.message.content)).toEqual(['q', 'a', 'r']);
  });

  it('control records never become messages even with stray role fields', () => {
    writer.append(asAppendablePiece({ role: 'user', content: 'x', kind: 'new' } as Record<string, unknown>));
    const { records } = readTranscript(filePath);
    // Even a hand-corrupted boundary record carrying role fields must never
    // become a message.
    const corrupted = records.slice();
    (corrupted[0] as Record<string, unknown>).kind = 'rollback';
    const messages = collateMessages(corrupted);
    expect(messages).toEqual([]);
    const anomalies: string[] = [];
    expect(collateEntries(corrupted, (a) => anomalies.push(a))).toEqual([]);
    expect(anomalies).toHaveLength(0);
  });
});