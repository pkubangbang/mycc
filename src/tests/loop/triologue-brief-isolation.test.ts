/**
 * triologue-brief-isolation.test.ts — validateBriefIsolation unit tests.
 *
 * Pure predicate: a turn is invalid only when `brief` appears ALONGSIDE other
 * tool calls. Lone brief, and turns without brief, are valid.
 */
import { describe, it, expect } from 'vitest';
import { validateBriefIsolation } from '../../loop/triologue/brief.js';

const call = (name: string) => ({ function: { name } });

describe('validateBriefIsolation', () => {
  it('accepts a turn with no brief', () => {
    expect(validateBriefIsolation([call('bash'), call('read_file')])).toEqual({ valid: true });
  });

  it('accepts an empty turn', () => {
    expect(validateBriefIsolation([])).toEqual({ valid: true });
  });

  it('accepts a lone brief', () => {
    expect(validateBriefIsolation([call('brief')])).toEqual({ valid: true });
  });

  it('rejects brief co-batched with another tool', () => {
    const result = validateBriefIsolation([call('brief'), call('bash')]);
    expect(result.valid).toBe(false);
    expect(result.message).toBe('Brief must be called alone. Other tools cannot be used in the same turn.');
  });
});
