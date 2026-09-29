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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { roleToType, roleToLabel, readHistory } from '../../serve/serve-history.js';

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
    expect(roleToLabel('assistant')).toBe('assistant');
  });

  it('returns undefined for user (right-aligned, no label needed)', () => {
    expect(roleToLabel('user')).toBeUndefined();
  });

  it('returns undefined for tool/system/unknown (no special label)', () => {
    expect(roleToLabel('tool')).toBeUndefined();
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
      JSON.stringify({ role: 'user', content: 'fix the bug', kind: 'user', user_origin: true, timestamp: 100 }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'on it', kind: 'new', timestamp: 200 }) + '\n',
      'utf-8',
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['fix the bug', 'on it']);
    expect(history[0].type).toBe('user');
    expect(history[1].type).toBe('result');
  });

  it('renders a steer journal record as a user bubble too', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'user', content: 'stop and reconsider', kind: 'steer', user_origin: true, timestamp: 50 }) + '\n',
      'utf-8',
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
      JSON.stringify({ role: 'assistant', content: 'working', kind: 'new', timestamp: 100 }) + '\n' +
      JSON.stringify({ role: 'tool', tool_name: 'bash', tool_call_id: 't1', content: 'out1', kind: 'new', timestamp: 200 }) + '\n' +
      JSON.stringify({ role: 'user', content: '[HINT] steering', kind: 'merge', timestamp: 250 }) + '\n' +
      JSON.stringify({ role: 'user', content: '[REMINDER] nudge', kind: 'new', timestamp: 260 }) + '\n',
      'utf-8',
    );
    const history = readHistory(transcriptPath, []);
    const contents = history.map((e) => e.content);
    expect(contents).toContain('working');
    expect(contents).toContain('out1');
    expect(contents).not.toContain('[HINT] steering');
    expect(contents).not.toContain('[REMINDER] nudge');
    expect(contents).toHaveLength(2);
    for (const e of history) expect(e.timestamp).toBeDefined();
  });

  it('legacy full-snapshot lines keep passing unchanged (each line = one entry)', () => {
    // Pre-piece format: whole-snapshot lines without `kind`. readTranscript
    // treats each as a 'new' plain Message — the raw-line parser behavior is
    // preserved, INCLUDING the {A, AB} duplicates baked into old files.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A', timestamp: 10 }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'AB', timestamp: 11 }) + '\n',
      'utf-8',
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
      JSON.stringify({ role: 'assistant', content: 'first', timestamp: 100 }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'second' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'third', timestamp: 300 }) + '\n',
      'utf-8',
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
      JSON.stringify({ role: 'assistant', content: 'A' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'B' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'C', timestamp: 100 }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'D', timestamp: 200 }) + '\n',
      'utf-8',
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['A', 'B', 'C', 'D']);
    expect(history.map((e) => e.timestamp)).toEqual([0, 0, 100, 200]);
  });

  it('P1: [100, 0, 200] inherits the preceding positive ts for the middle entry', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A', timestamp: 100 }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'B' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'C', timestamp: 200 }) + '\n',
      'utf-8',
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.timestamp)).toEqual([100, 100, 200]);
  });

  it('P1: [0, 0, 0] keeps file order (all equal, stable sort no-op)', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'B' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'C' }) + '\n',
      'utf-8',
    );
    const history = readHistory(transcriptPath, []);
    expect(history.map((e) => e.content)).toEqual(['A', 'B', 'C']);
    expect(history.map((e) => e.timestamp)).toEqual([0, 0, 0]);
  });

  it('P1: a legacy prefix stays BEFORE newer messageLog entries when merged', () => {
    // legacy A(0), B(0) + new transcript C(100) + live message M(50):
    // must render as M, A, B, C (prefix at head), NOT A, B, C where the
    // prefix was back-filled to 100 and jumped after M.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', content: 'A' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'B' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'C', timestamp: 100 }) + '\n',
      'utf-8',
    );
    const messageLog = [{ type: 'log' as const, content: 'M', timestamp: 50 }];
    const history = readHistory(transcriptPath, messageLog);
    expect(history.map((e) => e.content)).toEqual(['A', 'B', 'M', 'C']);
    expect(history.map((e) => e.timestamp)).toEqual([0, 0, 50, 100]);
  });

  it('merges transcript entries + in-memory messageLog chronologically by timestamp', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'tool', tool_name: 'bash', tool_call_id: 'x', content: 'toolout', kind: 'new', timestamp: 300 }) + '\n',
      'utf-8',
    );
    const messageLog = [{ type: 'log' as const, content: 'memlog', timestamp: 200 }];
    const history = readHistory(transcriptPath, messageLog);
    expect(history.map((e) => e.content)).toEqual(['memlog', 'toolout']);
  });

  it('regression fixture (849a9dd2): 9 genuine queries all render as user bubbles', () => {
    // A transcript polluted by injected notes between the 9 real queries —
    // every query must still round-trip to a right-side bubble.
    const lines: string[] = [];
    for (let i = 1; i <= 9; i++) {
      lines.push(JSON.stringify({ role: 'user', content: `query ${i}`, kind: 'user', user_origin: true, timestamp: i * 100 }));
      lines.push(JSON.stringify({ role: 'assistant', content: `reply ${i}`, kind: 'new', timestamp: i * 100 + 10 }));
      lines.push(JSON.stringify({ role: 'user', content: `[HINT] note ${i}`, kind: 'merge', timestamp: i * 100 + 20 }));
    }
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf-8');
    const history = readHistory(transcriptPath, []);
    const userBubbles = history.filter((e) => e.type === 'user');
    expect(userBubbles.map((e) => e.content)).toEqual(
      Array.from({ length: 9 }, (_, i) => `query ${i + 1}`),
    );
  });
});
