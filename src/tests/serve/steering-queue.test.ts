/**
 * steering-queue.test.ts - L1 unit tests for the pure steering queue logic
 *
 * Verifies the boomerang resolution semantics: the client declares which note
 * ids to SEND; everything not declared is implicitly discarded; the whole
 * queue drains atomically so a later peek cannot re-synthesize already-resolved
 * notes. Zero new dependencies — pure data-logic tests in the node environment.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSteeringQueue,
  joinSteeringNotes,
  type SteeringNote,
} from '../../serve/steering-queue.js';

function notes(...pairs: [number, string][]): SteeringNote[] {
  return pairs.map(([id, text]) => ({ id, text }));
}

describe('resolveSteeringQueue', () => {
  it('returns only the selected notes in queue order', () => {
    const queue = notes([1, 'a'], [2, 'b'], [3, 'c']);
    expect(resolveSteeringQueue(queue, [3, 1])).toEqual([
      { id: 1, text: 'a' },
      { id: 3, text: 'c' },
    ]);
  });

  it('discards unselected notes (does not return them)', () => {
    const queue = notes([1, 'keep'], [2, 'drop'], [3, 'keep2']);
    const selected = resolveSteeringQueue(queue, [1, 3]);
    expect(selected.map((n) => n.id)).toEqual([1, 3]);
    expect(selected.some((n) => n.text === 'drop')).toBe(false);
  });

  it('empty/omitted selection means discard-all (returns [])', () => {
    const queue = notes([1, 'a'], [2, 'b']);
    expect(resolveSteeringQueue(queue, [])).toEqual([]);
    expect(resolveSteeringQueue(queue)).toEqual([]);
  });

  it('handles duplicate text keyed by distinct ids (targets by id, not text)', () => {
    const queue = notes([1, 'same'], [2, 'same'], [3, 'other']);
    // Only the first duplicate text is selected, proving id-keyed targeting.
    expect(resolveSteeringQueue(queue, [2]).map((n) => n.text)).toEqual(['same']);
    expect(resolveSteeringQueue(queue, [2]).map((n) => n.id)).toEqual([2]);
  });

  it('returns [] for an unknown id and an empty queue', () => {
    expect(resolveSteeringQueue([], [7])).toEqual([]);
    expect(resolveSteeringQueue(notes([1, 'a']), [999])).toEqual([]);
  });

  // duplicate-id boundary (test-strength dir-14 round-10): when two notes
  // share the same id, a single sendIds entry selects BOTH. The filter-based
  // implementation keeps every note whose id is in sendIds, so duplicate ids
  // are not de-duplicated. This test pins the current contract; if the
  // implementation is later changed to dedupe, update the expectation here.
  it('selects all notes sharing a duplicate id when that id is sent', () => {
    const queue = notes([1, 'a'], [1, 'b']);
    const selected = resolveSteeringQueue(queue, [1]);
    expect(selected).toHaveLength(2);
    expect(selected.map((n) => n.text)).toEqual(['a', 'b']);
  });
});

describe('joinSteeringNotes', () => {
  it('joins selected notes with a blank line', () => {
    expect(joinSteeringNotes(notes([1, 'a'], [2, 'b']))).toBe('a\n\nb');
  });

  it('returns empty string for empty selection', () => {
    expect(joinSteeringNotes([])).toBe('');
  });
});
