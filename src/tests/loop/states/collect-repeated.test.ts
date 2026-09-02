/**
 * collect-repeated.test.ts - Unit tests for the dead-loop detection helpers
 * in the COLLECT state.
 *
 * `detectRepeatedActions` feeds objective evidence into the hint-round
 * breakdown so the LLM judges should_compact on facts (a repeated-action
 * line) rather than a vague "the conversation feels long" feeling — which
 * was over-triggering compaction. The contract:
 *   - 3+ CONSECUTIVE same-tool calls sharing a common error-ish result prefix
 *     → report `Repeated actions: <tool> ×<count> (results start with "<prefix>")`
 *   - otherwise → null (LLM defaults should_compact=false)
 *
 * Only `detectRepeatedActions` is exercised here; `commonErrorPrefix` is a
 * private helper covered transitively through it (it gates the 3+ errorish
 * + longest-common-prefix logic).
 */
import { describe, it, expect } from 'vitest';
import { detectRepeatedActions } from '../../../loop/states/collect.js';
import type { SequenceEvent } from '../../../hook/sequence.js';

/** Build a SequenceEvent with minimal fields. */
function ev(tool: string, result: string): SequenceEvent {
  return { tool, args: {}, result, timestamp: 0 };
}

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