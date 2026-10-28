/**
 * steering-observer.test.ts - emission is INTRINSIC to mutation
 *
 * The old protocol made each drain site hand-broadcast a payload-less
 * `steer-flush` (four sites, five calls), so a new drain site added later
 * would silently forget to tell the WebUI. Now every mutator bumps a revision
 * and notifies subscribers with the whole queue; ServeHub registers exactly
 * one observer in start(). These tests pin the manager half of that contract:
 *
 *   - one emit per MUTATION (not per call — a no-op drain emits nothing),
 *   - the emitted snapshot is post-mutation and is a copy (no aliasing),
 *   - a throwing observer cannot break the mutation or starve the others,
 *   - unsubscribe stops emission.
 *
 * Framework-free: the manager has no imports, so this suite needs no mocks.
 */
import { describe, it, expect, vi } from 'vitest';
import { SteeringManager, type SteeringSnapshot } from '../../loop/steering-manager.js';

function recorder() {
  const seen: SteeringSnapshot[] = [];
  return { seen, listener: (s: SteeringSnapshot) => { seen.push(s); } };
}

describe('SteeringManager — revisioned snapshot emission', () => {
  it('addNote emits once with a bumped revision and the note included', () => {
    const m = new SteeringManager();
    const { seen, listener } = recorder();
    m.onChange(listener);
    m.addNote('a');
    expect(seen).toHaveLength(1);
    expect(seen[0].revision).toBe(1);
    expect(seen[0].notes.map((n) => n.id)).toEqual([1]);
  });

  it('revisions strictly increase across mutations', () => {
    const m = new SteeringManager();
    const { seen, listener } = recorder();
    m.onChange(listener);
    m.addNote('a');
    m.addNote('b');
    m.drainNotes();
    m.clear();
    expect(seen.map((s) => s.revision)).toEqual([1, 2, 3, 4]);
  });

  it('an EMPTY drain emits nothing (COLLECT drains every turn)', () => {
    const m = new SteeringManager();
    const { seen, listener } = recorder();
    m.onChange(listener);
    m.drainNotes();
    m.drainNotes();
    expect(seen).toHaveLength(0);
  });

  it('takeForDelivery that HOLDS emits nothing; the delivering call emits once', () => {
    const m = new SteeringManager();
    const { seen, listener } = recorder();
    m.onChange(listener);
    m.addNote('held');
    seen.length = 0;
    // Not parked → hold (no state change, no report).
    expect(m.takeForDelivery(false, false)).toBeNull();
    expect(m.takeForDelivery(false, true)).toBeNull();
    expect(seen).toHaveLength(0);
    // Parked + wrap-up settled → delivers and reports the now-empty queue.
    expect(m.takeForDelivery(true, false)).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].notes).toEqual([]);
  });

  it('clear() emits even when already empty (authoritative empty statement)', () => {
    const m = new SteeringManager();
    const { seen, listener } = recorder();
    m.onChange(listener);
    m.clear();
    expect(seen).toHaveLength(1);
    expect(seen[0].revision).toBe(1);
    expect(seen[0].notes).toEqual([]);
  });

  it('a throwing observer is isolated — the mutation still completes and others run', () => {
    const m = new SteeringManager();
    const good = recorder();
    m.onChange(() => { throw new Error('boom'); });
    m.onChange(good.listener);
    expect(() => m.addNote('still added')).not.toThrow();
    expect(m.peekTexts()).toEqual(['still added']);
    expect(good.seen).toHaveLength(1);
  });

  it('unsubscribe stops emission for that listener only', () => {
    const m = new SteeringManager();
    const a = recorder();
    const b = recorder();
    const offA = m.onChange(a.listener);
    m.onChange(b.listener);
    m.addNote('one');
    offA();
    m.addNote('two');
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(2);
    expect(typeof offA).toBe('function');
  });

  it('snapshot() returns a COPY — mutating it cannot corrupt the queue', () => {
    const m = new SteeringManager();
    m.addNote('a');
    const snap = m.snapshot();
    snap.notes.push({ id: 999, text: 'injected' });
    expect(m.peekNotes().map((n) => n.id)).toEqual([1]);
  });

  it('getRevision() reports the current version (used by the /history ETag)', () => {
    const m = new SteeringManager();
    expect(m.getRevision()).toBe(0);
    m.addNote('a');
    expect(m.getRevision()).toBe(1);
  });

  it('resolveBoomerang emits exactly once for the whole atomic drain', () => {
    const m = new SteeringManager();
    m.addNote('keep');
    m.addNote('drop');
    const spy = vi.fn();
    m.onChange(spy);
    const { selected, discarded } = m.resolveBoomerang([1]);
    expect(selected.map((n) => n.text)).toEqual(['keep']);
    expect(discarded.map((n) => n.text)).toEqual(['drop']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(m.peekNotes()).toEqual([]);
  });
});
