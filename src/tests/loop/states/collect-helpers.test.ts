/**
 * collect-helpers.test.ts - Unit tests for the COLLECT state's pure helpers:
 * the STOP-guard JSON parser and the dead-loop (repeated-action) detector.
 *
 * Both are pure functions behind a forkChat/LLM boundary, so they need no mocks
 * and share no state: they live together as one "COLLECT helpers" behaviour
 * file. The state-machine wiring around them is covered by the integration
 * suites (collect-keyword-*.test.ts, collect-esc-hint.test.ts).
 *
 * parsePreventStopResult: `checkPreventStop` asks the LLM (via forkChat) for
 * a JSON array; the parser must tolerate surrounding noise and reject
 * malformed output without throwing (null means the gate fails OPEN).
 *
 * detectRepeatedActions: feeds objective evidence into the hint-round breakdown
 * so the LLM's next_step advice targets the actual loop (a repeated-action
 * line) rather than a vague "the conversation feels long" feeling. The contract:
 *   - 3+ CONSECUTIVE same-tool calls sharing a common error-ish result prefix
 *     → report `Repeated actions: <tool> ×<count> (results start with "<prefix>")`
 *   - otherwise → null (no repeated-action line added)
 *
 * Only `detectRepeatedActions` is exercised; `commonErrorPrefix` is a private
 * helper covered transitively through it (it gates the 3+ errorish +
 * longest-common-prefix logic).
 */
import { describe, it, expect } from 'vitest';
import { parsePreventStopResult } from '../../../loop/states/stop-prevent-stop.js';
import { detectRepeatedActions } from '../../../loop/hint-round.js';
import type { SequenceEvent } from '../../../hook/sequence.js';

/** Build a SequenceEvent with minimal fields. */
function ev(tool: string, result: string): SequenceEvent {
  return { tool, args: {}, result, timestamp: 0 };
}

describe('parsePreventStopResult', () => {
  it('should parse a clean JSON array', () => {
    const raw = '[{"id":2,"hash":"abc12345","held":true,"reason":"tests still failing"}]';
    const result = parsePreventStopResult(raw);
    expect(result).toEqual([
      { id: 2, hash: 'abc12345', held: true, reason: 'tests still failing' },
    ]);
  });

  it('should parse multiple entries', () => {
    const raw = '[{"id":1,"hash":"h1","held":false},{"id":2,"hash":"h2","held":true,"reason":"not done"}]';
    const result = parsePreventStopResult(raw);
    expect(result).toEqual([
      { id: 1, hash: 'h1', held: false },
      { id: 2, hash: 'h2', held: true, reason: 'not done' },
    ]);
  });

  it('should extract a JSON array from surrounding noise text', () => {
    const raw = 'Here is my verdict:\n[{"id":2,"hash":"abc","held":true,"reason":"x"}]\nHope that helps!';
    const result = parsePreventStopResult(raw);
    expect(result).toEqual([{ id: 2, hash: 'abc', held: true, reason: 'x' }]);
  });

  it('should return null for non-JSON text (caller fails OPEN)', () => {
    expect(parsePreventStopResult('HELD because tests fail')).toBeNull();
    expect(parsePreventStopResult('')).toBeNull();
    expect(parsePreventStopResult('   ')).toBeNull();
  });

  it('should return null for JSON that is not an array', () => {
    expect(parsePreventStopResult('{"id":2,"held":true}')).toBeNull();
    expect(parsePreventStopResult('"just a string"')).toBeNull();
    expect(parsePreventStopResult('42')).toBeNull();
  });

  it('should return null for malformed JSON array (unclosed)', () => {
    expect(parsePreventStopResult('[{"id":2,"held":true')).toBeNull();
  });

  it('should tolerate whitespace around the JSON array', () => {
    const raw = '   \n  [{"id":5,"hash":"h","held":false,"reason":"skip"}]  \n  ';
    expect(parsePreventStopResult(raw)).toEqual([
      { id: 5, hash: 'h', held: false, reason: 'skip' },
    ]);
  });
});
describe('detectRepeatedActions', () => {
  it('reports 3+ consecutive same-tool calls sharing an error prefix', () => {
    const events = [
      ev('edit_file', 'Error: old_text not found in file'),
      ev('edit_file', 'Error: old_text not found in file (line 42)'),
      ev('edit_file', 'Error: old_text not found in file (line 99)'),
    ];
    const result = detectRepeatedActions(events);
    expect(result).toContain('edit_file');
    expect(result).toMatch(/×3/);
    expect(result).toContain('Error:');
  });

  it('returns null when only 2 same-tool calls repeat (below the 3+ threshold)', () => {
    const events = [
      ev('edit_file', 'Error: old_text not found'),
      ev('edit_file', 'Error: old_text not found'),
    ];
    expect(detectRepeatedActions(events)).toBeNull();
  });

  it('returns null when there are fewer than 3 events total', () => {
    const events = [
      ev('edit_file', 'Error: x'),
      ev('edit_file', 'Error: x'),
    ];
    expect(detectRepeatedActions(events)).toBeNull();
  });

  it('returns null when results are NOT error-ish (no error prefix marker)', () => {
    // Three identical successful read_file results — NOT a dead-loop.
    const events = [
      ev('read_file', 'File contents here, line 1...'),
      ev('read_file', 'File contents here, line 1...'),
      ev('read_file', 'File contents here, line 1...'),
    ];
    expect(detectRepeatedActions(events)).toBeNull();
  });

  it('does not merge different tools into one group', () => {
    // Alternating tools, each only 1-long groups → no 3+ group.
    const events = [
      ev('edit_file', 'Error: not found'),
      ev('bash', 'Error: command failed'),
      ev('edit_file', 'Error: not found'),
      ev('bash', 'Error: command failed'),
    ];
    expect(detectRepeatedActions(events)).toBeNull();
  });

  it('only inspects the trailing window, ignoring older repetition', () => {
    // Old run of 3 bash errors at the START, then a gap of 6 distinct
    // non-error calls so the old group falls outside the trailing -8 window,
    // and the recent tail has no 3+ error group → null.
    const events = [
      ev('bash', 'Error: failed step 1'),
      ev('bash', 'Error: failed step 2'),
      ev('bash', 'Error: failed step 3'),
      ev('read_file', 'ok 1'),
      ev('read_file', 'ok 2'),
      ev('read_file', 'ok 3'),
      ev('read_file', 'ok 4'),
      ev('read_file', 'ok 5'),
      ev('read_file', 'ok 6'),
      ev('edit_file', 'done'),
      ev('edit_file', 'done'),
    ];
    expect(detectRepeatedActions(events)).toBeNull();
  });

  it('picks the largest group when multiple 3+ groups exist', () => {
    const events = [
      ev('edit_file', 'Error: old_text not found'),
      ev('edit_file', 'Error: old_text not found'),
      ev('edit_file', 'Error: old_text not found'),
      ev('bash', 'Error: command not found'),
      ev('bash', 'Error: command not found'),
      ev('bash', 'Error: command not found'),
      ev('bash', 'Error: command not found'),
    ];
    const result = detectRepeatedActions(events);
    // bash group (4) is larger than edit_file group (3)
    expect(result).toContain('bash');
    expect(result).toMatch(/×4/);
  });

  it('detects "not found" / "does not match" error markers, not just "Error:"', () => {
    const events = [
      ev('grep', 'No such pattern found in any file'),
      ev('grep', 'No such pattern found in any file'),
      ev('grep', 'No such pattern found in any file'),
    ];
    const result = detectRepeatedActions(events);
    expect(result).toContain('grep');
    expect(result).toMatch(/×3/);
  });

  it('returns null for an empty event array', () => {
    expect(detectRepeatedActions([])).toBeNull();
  });
});
