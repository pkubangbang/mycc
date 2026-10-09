/**
 * steering-manager.test.ts - L1 unit tests for the loop-homed steering manager
 *
 * This file MOVES the former src/tests/serve/steering-queue.test.ts cases
 * verbatim (only the import target changed, to the manager module) and adds:
 * - singleton-identity + fresh-id continuation + clear() lifecycle cases,
 * - the takeForDelivery boolean decision matrix (docs/steering-manager-plan.md
 *   §3) with plain booleans — zero registration stubs.
 *
 * Verifies the boomerang resolution semantics: the client declares which note
 * ids to SEND; everything not declared is implicitly discarded; the whole
 * queue drains atomically so a later peek cannot re-synthesize already-resolved
 * notes. Zero new dependencies — pure data-logic tests in the node environment.
 */
import { describe, it, expect } from 'vitest';
import {
  SteeringManager,
  getSteeringManager,
  resolveSteeringQueue,
  joinSteeringNotes,
  type SteeringNote,
} from '../../loop/steering-manager.js';

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

describe('SteeringManager', () => {
  it('addNote mints monotonic ids starting at 1 and returns the note', () => {
    const m = new SteeringManager();
    const a = m.addNote('first');
    const b = m.addNote('second');
    expect(a).toEqual({ id: 1, text: 'first' });
    expect(b).toEqual({ id: 2, text: 'second' });
  });

  it('peekNotes returns {id,text} copies without consuming', () => {
    const m = new SteeringManager();
    m.addNote('a');
    const peeked = m.peekNotes();
    expect(peeked).toEqual([{ id: 1, text: 'a' }]);
    // Mutating the copy must not touch the queue.
    peeked.push({ id: 99, text: 'x' });
    expect(m.peekNotes()).toHaveLength(1);
  });

  it('peekTexts returns texts in queue order without consuming', () => {
    const m = new SteeringManager();
    m.addNote('a');
    m.addNote('b');
    expect(m.peekTexts()).toEqual(['a', 'b']);
    expect(m.isNonEmpty()).toBe(true);
  });

  it('drainNotes returns all notes atomically and empties the queue', () => {
    const m = new SteeringManager();
    m.addNote('a');
    m.addNote('b');
    expect(m.drainNotes()).toEqual([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
    expect(m.isNonEmpty()).toBe(false);
    expect(m.drainNotes()).toEqual([]);
  });

  it('resolveBoomerang returns selected + discarded and drains the queue', () => {
    const m = new SteeringManager();
    m.addNote('a');
    m.addNote('b');
    m.addNote('keep');
    const { selected, discarded } = m.resolveBoomerang([2, 3]);
    expect(selected).toEqual([{ id: 2, text: 'b' }, { id: 3, text: 'keep' }]);
    expect(discarded).toEqual([{ id: 1, text: 'a' }]);
    expect(m.isNonEmpty()).toBe(false);
  });

  it('resolveBoomerang with empty sendIds discards all and selects none', () => {
    const m = new SteeringManager();
    m.addNote('a');
    const { selected, discarded } = m.resolveBoomerang();
    expect(selected).toEqual([]);
    expect(discarded.map((n) => n.text)).toEqual(['a']);
    expect(m.isNonEmpty()).toBe(false);
  });

  it('resolveBoomerang keeps the duplicate-id no-dedupe contract (A4)', () => {
    // Simulate the duplicate-id boundary: clear() keeps ids monotonic, so we
    // build the boundary directly through the pure function instead.
    const queue = notes([1, 'a'], [1, 'b']);
    const selected = resolveSteeringQueue(queue, [1]);
    expect(selected).toHaveLength(2);
  });

  it('isNonEmpty/drain on an empty manager are natural no-ops', () => {
    const m = new SteeringManager();
    expect(m.isNonEmpty()).toBe(false);
    expect(m.peekNotes()).toEqual([]);
    expect(m.peekTexts()).toEqual([]);
    expect(m.drainNotes()).toEqual([]);
    expect(m.resolveBoomerang([1])).toEqual({ selected: [], discarded: [] });
  });

  it('clear() wipes notes but keeps the id counter monotonic', () => {
    const m = new SteeringManager();
    m.addNote('a');
    m.clear();
    expect(m.isNonEmpty()).toBe(false);
    const b = m.addNote('b');
    expect(b.id).toBe(2); // ids never reset — frontend dedupe/targeting stays safe
  });

  it('getSteeringManager returns the same process-wide singleton', () => {
    expect(getSteeringManager()).toBe(getSteeringManager());
  });

  describe('takeForDelivery — decision matrix (plain booleans, no stubs)', () => {
    it('empty queue → null regardless of flags', () => {
      const m = new SteeringManager();
      expect(m.takeForDelivery(true, false)).toBeNull();
      expect(m.takeForDelivery(true, true)).toBeNull();
      expect(m.takeForDelivery(false, false)).toBeNull();
      expect(m.takeForDelivery(false, true)).toBeNull();
    });

    it('parked + wrap-up closed → delivers (drains) held notes', () => {
      const m = new SteeringManager();
      m.addNote('held');
      expect(m.takeForDelivery(true, false)).toEqual([{ id: 1, text: 'held' }]);
      expect(m.isNonEmpty()).toBe(false);
    });

    it('parked + wrap-up in flight → holds (null) and keeps notes', () => {
      const m = new SteeringManager();
      m.addNote('held');
      expect(m.takeForDelivery(true, true)).toBeNull();
      expect(m.isNonEmpty()).toBe(true);
      expect(m.peekTexts()).toEqual(['held']);
    });

    it('loop busy (not parked) → holds regardless of wrap-up state', () => {
      const m = new SteeringManager();
      m.addNote('held');
      expect(m.takeForDelivery(false, false)).toBeNull();
      m.addNote('held2');
      expect(m.takeForDelivery(false, true)).toBeNull();
      expect(m.peekTexts()).toEqual(['held', 'held2']);
    });

    it('repeated calls while holding never consume; the delivery instant does', () => {
      const m = new SteeringManager();
      m.addNote('a');
      m.addNote('b');
      expect(m.takeForDelivery(false, true)).toBeNull();
      expect(m.takeForDelivery(true, true)).toBeNull();
      expect(m.takeForDelivery(false, false)).toBeNull();
      expect(m.takeForDelivery(true, false)).toEqual([
        { id: 1, text: 'a' },
        { id: 2, text: 'b' },
      ]);
      expect(m.takeForDelivery(true, false)).toBeNull();
    });
  });
});