/**
 * serve-history.test.ts - unit tests for role mapping + history collation
 *
 * Covers roleToType / roleToLabel: these map triologue Message roles to
 * WebUI LogEntry types/labels and are the key rendering contract for the
 * /history endpoint. Includes the unknown / undefined role branches.
 *
 * readHistory is now sourced from the triologue transcript journal alone
 * (the serve-only user.jsonl side file was deleted): right-side user
 * bubbles come from kind:'user'|'steer' records stamped user_origin:true,
 * while marker-less 'new' user records (injected notes) and 'merge'
 * fragments never render. Untimestamped legacy lines inherit the previous
 * positive timestamp (emission order) rather than sorting to the head.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { roleToType, roleToLabel, readHistory } from '../../serve/serve-history.js';
import { collateMessages } from '../../loop/triologue/transcript.js';
import type { LogEntry } from '../../serve/serve-types.js';

describe('roleToType', () => {
  it('maps known roles to their LogEntry types', () => {
    expect(roleToType('user')).toBe('user');
    expect(roleToType('assistant')).toBe('result');
    expect(roleToType('tool')).toBe('log');
    expect(roleToType('system')).toBe('system');
  });

  it('falls back to log for unknown roles', () => {
    expect(roleToType('function')).toBe('log');
    expect(roleToType('whatever')).toBe('log');
  });

  it('falls back to log for undefined role', () => {
    expect(roleToType(undefined)).toBe('log');
  });
});

describe('roleToLabel', () => {
  it('labels assistant role as "assistant"', () => {
    // An assistant turn projects to type 'result' with NO label, and the
    // client hides unlabeled non-user/prompt entries when 详细日志 is off —
    // so an unlabeled assistant turn would erase the agent's prose from
    // every /history reload. The live broadcast() path labels it too.
    expect(roleToLabel('assistant')).toBe('assistant');
  });

  it('returns undefined for user (right-aligned, no label needed)', () => {
    expect(roleToLabel('user')).toBeUndefined();
  });

  it('labels tool role as "tool" so tool output survives the verbose-logs filter', () => {
    // Regression: an unlabeled log entry is HIDDEN by isMessageVisible() in
    // src/web/src/main.ts when "详细日志" is off. Tool output is the body of a
    // tool card, not background noise, so it must carry a label or the whole
    // session's tool results disappear on every history reload (observed: 173
    // of 270 log entries arrived label-less and were filtered out).
    expect(roleToLabel('tool')).toBe('tool');
  });

  it('returns undefined for system/unknown (no special label)', () => {
    expect(roleToLabel('system')).toBeUndefined();
    expect(roleToLabel('function')).toBeUndefined();
  });

  it('returns undefined for undefined role', () => {
    expect(roleToLabel(undefined)).toBeUndefined();
  });
});

describe('readHistory (transcript journal projection)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-history-rh-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders a genuine user query as a bubble with NO user.jsonl side file', () => {
    // A kind:'user' journal record (user_origin:true) IS the source of the
    // right-side bubble — the deleted user.jsonl is gone entirely.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'user', content: 'fix the bug', kind: 'user', user_origin: true, timestamp: 100 }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'on it', kind: 'new', timestamp: 200 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['fix the bug', 'on it']);
    expect(history[0].type).toBe('user');
    expect(history[1].type).toBe('result');
  });

  it('renders a steer journal record as a user bubble too', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        role: 'user',
        content: 'stop and reconsider',
        kind: 'steer',
        user_origin: true,
        timestamp: 50
      }) + '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ type: 'user', content: 'stop and reconsider', timestamp: 50 });
  });

  it('never renders an injected note: marker-less new-user and merge records are skipped', () => {
    // The [HINT] merge fragment and the marker-less 'new' [REMINDER] note
    // are injected (not user_origin) — neither may surface as a bubble.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'working', kind: 'new', timestamp: 100 }) +
        '\n' +
        JSON.stringify({
          role: 'tool',
          tool_name: 'bash',
          tool_call_id: 't1',
          content: 'out1',
          kind: 'new',
          timestamp: 200
        }) +
        '\n' +
        JSON.stringify({ role: 'user', content: '[HINT] steering', kind: 'merge', timestamp: 250 }) +
        '\n' +
        JSON.stringify({ role: 'user', content: '[REMINDER] nudge', kind: 'new', timestamp: 260 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    const contents = history.map((e) => e.content);
    expect(contents).toContain('working');
    // Tool records do NOT project a row: the terminal shows tool activity
    // through brief() notes, never by echoing the raw result, and /history now
    // renders the same stream. The record is skipped, not filtered late.
    expect(contents).not.toContain('out1');
    expect(contents).not.toContain('[HINT] steering');
    expect(contents).not.toContain('[REMINDER] nudge');
    expect(contents).toHaveLength(1);
    for (const e of history) expect(e.timestamp).toBeDefined();
  });

  it('legacy full-snapshot lines keep passing unchanged (each line = one entry)', () => {
    // Pre-piece format: whole-snapshot lines without `kind`. readTranscript
    // treats each as a 'new' plain Message — the raw-line parser behavior is
    // preserved, INCLUDING the {A, AB} duplicates baked into old files.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A', timestamp: 10 }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'AB', timestamp: 11 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['A', 'AB']);
    expect(history.map((e) => e.timestamp)).toEqual([10, 11]);
  });

  it('normalises untimestamped legacy lines in emission order (no jump to head)', () => {
    // Pitfall 8547e85b: a ts===0 line must inherit the PREVIOUS positive
    // timestamp, keeping emission order — NOT sort to the head of the list.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'first', timestamp: 100 }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'second' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'third', timestamp: 300 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['first', 'second', 'third']);
    // second inherits 100 (emission order), never 0.
    expect(history[1].timestamp).toBe(100);
  });

  it('P1: a LEADING untimestamped prefix stays at 0 (no back-fill from a later record)', () => {
    // [0, 0, 100, 200] — the leading untimestamped records must NOT be
    // back-filled to 100 (the ts of a LATER record); they keep 0 so they sort
    // to the head, preserving the legacy prefix.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'B' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'C', timestamp: 100 }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'D', timestamp: 200 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['A', 'B', 'C', 'D']);
    expect(history.map((e) => e.timestamp)).toEqual([0, 0, 100, 200]);
  });

  it('P1: [100, 0, 200] inherits the preceding positive ts for the middle entry', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A', timestamp: 100 }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'B' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'C', timestamp: 200 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.timestamp)).toEqual([100, 100, 200]);
  });

  it('P1: [0, 0, 0] keeps file order (all equal, stable sort no-op)', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'B' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'C' }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['A', 'B', 'C']);
    expect(history.map((e) => e.timestamp)).toEqual([0, 0, 0]);
  });

  it('P1: a legacy prefix stays BEFORE newer transcript entries (file order)', () => {
    // legacy A(0), B(0) + new transcript C(100): file order must survive —
    // the stream position is the sort key, so an untimestamped prefix can
    // never be re-ordered relative to a later record.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'B' }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'C', timestamp: 100 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['A', 'B', 'C']);
  });

  it('does NOT merge the in-memory messageLog: the transcript is the single source', () => {
    // The duplicate-card bug: merging a projection of the same turns with the
    // live mirror shipped one assistant reply as two identical cards. The
    // projection now ignores messageLog whenever a transcript exists.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'reply', kind: 'new', timestamp: 300 }) + '\n',
      'utf-8'
    );
    const messageLog = [{ type: 'result' as const, content: 'reply', label: 'assistant', timestamp: 300 }];
    const history = readHistory(transcriptPath, messageLog);
    expect(history.map((e) => e.content)).toEqual(['reply']);
  });

  it('renders a display note as a labelled row (what the terminal printed)', () => {
    // agentIO.brief() journals a role-less 'note' record; /history must replay
    // it as the same labelled line, at the same position in the stream.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        kind: 'note',
        note: { level: 'info', tool: 'bash', text: 'listed 3 files', at: '13:30:42', detail: 'RUN list' },
        timestamp: 10,
        seq: 1
      }) +
        '\n' +
        JSON.stringify({ role: 'assistant', content: 'done', kind: 'new', timestamp: 20, seq: 2 }) +
        '\n',
      'utf-8'
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => [e.type, e.label, e.content])).toEqual([
      ['log', 'bash', 'listed 3 files'],
      ['result', 'assistant', 'done']
    ]);
    expect(history[0].detail).toBe('RUN list');
    expect(history.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('a note never becomes a message for the LLM (collateMessages drops it)', () => {
    const records = [
      {
        kind: 'note',
        note: { level: 'warn', tool: 'tool', text: 'segment failed', at: '13:30:42' },
        timestamp: 10,
        seq: 1
      },
      { role: 'assistant', content: 'reply', kind: 'new', timestamp: 20, seq: 2 }
    ];
    const messages = collateMessages(records as never);
    expect(messages.map((m: { content: string }) => m.content)).toEqual(['reply']);
  });

  it('falls back to the log while the transcript file is EMPTY (serve up before the first journal line)', () => {
    // writeFreshSessionFiles creates the file at boot, BEFORE serve can start,
    // so the path is already non-null when serve comes up. Keying the fallback
    // on "is there a path" would project zero rows and drop every turn recorded
    // before the first journal line — a bubble that renders 0 times.
    fs.writeFileSync(transcriptPath, '');
    const messageLog: LogEntry[] = [
      { type: 'user' as const, content: 'typed early', timestamp: 10 },
      { type: 'log' as const, content: 'a brief line', label: 'brief', timestamp: 11 }
    ];
    const history = readHistory(transcriptPath, messageLog);
    expect(history.map((e) => e.content)).toEqual(['typed early', 'a brief line']);
  });

  it('does NOT fall back when the transcript is populated but PROJECTS to nothing', () => {
    // The trap: tool records + a synthetic note + a boundary mark is a normal,
    // populated transcript that happens to draw no row. "Projection is empty"
    // would resurrect a stale serve-lifetime log over a real journal; the
    // correct predicate is "the file has journaled nothing at all".
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ role: 'tool', tool_name: 'bash', tool_call_id: 't1', content: 'raw output', kind: 'new', timestamp: 20 }),
        JSON.stringify({ kind: 'note', note: { level: 'info', tool: 'hook', text: 'machine noise', at: '00:00:00', synthetic: true }, timestamp: 21 }),
        JSON.stringify({ kind: 'clear', timestamp: 22 })
      ].join('\n') + '\n',
      'utf-8'
    );
    const messageLog: LogEntry[] = [{ type: 'log' as const, content: 'stale serve-only line', timestamp: 10 }];
    const history = readHistory(transcriptPath, messageLog);
    expect(history).toEqual([]);
  });

  it('hands over to the transcript from the first journaled record onward', () => {
    // One real record appears: the transcript now owns history outright and the
    // serve-lifetime log is never consulted again.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'first real line', kind: 'new', timestamp: 30 }) + '\n',
      'utf-8'
    );
    const messageLog: LogEntry[] = [{ type: 'log' as const, content: 'stale serve-only line', timestamp: 10 }];
    const history = readHistory(transcriptPath, messageLog);
    expect(history.map((e) => e.content)).toEqual(['first real line']);
  });

  it('regression fixture (849a9dd2): 9 genuine queries all render as user bubbles', () => {
    // A transcript polluted by injected notes between the 9 real queries —
    // every query must still round-trip to a right-side bubble.
    const lines: string[] = [];
    for (let i = 1; i <= 9; i++) {
      lines.push(
        JSON.stringify({ role: 'user', content: `query ${i}`, kind: 'user', user_origin: true, timestamp: i * 100 })
      );
      lines.push(JSON.stringify({ role: 'assistant', content: `reply ${i}`, kind: 'new', timestamp: i * 100 + 10 }));
      lines.push(JSON.stringify({ role: 'user', content: `[HINT] note ${i}`, kind: 'merge', timestamp: i * 100 + 20 }));
    }
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf-8');
    const history = readHistory(transcriptPath, []);
    const userBubbles = history.filter((e) => e.type === 'user');
    expect(userBubbles.map((e) => e.content)).toEqual(Array.from({ length: 9 }, (_, i) => `query ${i + 1}`));
  });
});
