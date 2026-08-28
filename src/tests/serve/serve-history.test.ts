/**
 * serve-history.test.ts - unit tests for role mapping + user-log reading
 *
 * Covers roleToType / roleToLabel (test-strength dir-14 round-10 weakness 4):
 * these map triologue Message roles to WebUI LogEntry types/labels and are
 * the key rendering contract for the /history endpoint. Includes the unknown
 * / undefined role branches, which had zero coverage. Also exercises
 * readUserLog against a temp-dir fixture (malformed lines skipped, empty
 * content skipped, timestamps carried through).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { roleToType, roleToLabel, readUserLog } from '../../serve/serve-history.js';

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

describe('readUserLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-history-'));
    logPath = path.join(tmpDir, 'user.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the path is null', () => {
    expect(readUserLog(null)).toEqual([]);
  });

  it('returns [] when the file does not exist', () => {
    expect(readUserLog(logPath)).toEqual([]);
  });

  it('reads well-formed user-log lines as user LogEntries', () => {
    fs.writeFileSync(
      logPath,
      JSON.stringify({ type: 'user', content: 'hello', kind: 'prompt', timestamp: 1000 }) + '\n' +
      JSON.stringify({ type: 'user', content: 'steer me', kind: 'steer', timestamp: 2000 }) + '\n',
      'utf-8',
    );
    const entries = readUserLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ type: 'user', content: 'hello', timestamp: 1000 });
    expect(entries[1]).toEqual({ type: 'user', content: 'steer me', timestamp: 2000 });
  });

  it('skips malformed JSON lines without throwing', () => {
    fs.writeFileSync(
      logPath,
      '{not json\n' +
      JSON.stringify({ content: 'good', timestamp: 5 }) + '\n',
      'utf-8',
    );
    const entries = readUserLog(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('good');
  });

  it('skips entries with empty/null/undefined content', () => {
    fs.writeFileSync(
      logPath,
      JSON.stringify({ content: '', timestamp: 1 }) + '\n' +
      JSON.stringify({ content: null, timestamp: 2 }) + '\n' +
      JSON.stringify({ timestamp: 3 }) + '\n' +
      JSON.stringify({ content: 'keep', timestamp: 4 }) + '\n',
      'utf-8',
    );
    const entries = readUserLog(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('keep');
  });

  it('strips ANSI codes from content', () => {
    fs.writeFileSync(
      logPath,
      JSON.stringify({ content: '\x1b[31mred\x1b[0m', timestamp: 1 }) + '\n',
      'utf-8',
    );
    expect(readUserLog(logPath)[0].content).toBe('red');
  });

  it('omits timestamp when the line has no numeric timestamp', () => {
    fs.writeFileSync(
      logPath,
      JSON.stringify({ content: 'no-ts' }) + '\n',
      'utf-8',
    );
    const entry = readUserLog(logPath)[0];
    expect(entry.content).toBe('no-ts');
    expect(entry.timestamp).toBeUndefined();
  });
});