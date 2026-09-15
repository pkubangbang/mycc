/**
 * todo.test.ts - Direct unit tests for the Todo class (not the tool wrapper)
 * Verifies hash integrity, auto-clear-on-all-done, and monotonic nextId.
 */

import { describe, it, expect } from 'vitest';
import { Todo } from '../../../context/shared/todo.js';

describe('Todo', () => {
  it('should auto-clear items when the last open item is marked done', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    // Mark A done — B still open, list should remain
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems().length).toBe(2);

    // Mark B done — all done, list should auto-clear
    const result = todo.updateTodo(b.id, b.hash, b.name, true);
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(todo.getItems().length).toBe(0);
    expect(todo.hasOpenTodo()).toBe(false);
  });

  it('should keep nextId monotonic across auto-clear', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    // items now cleared
    expect(todo.getItems().length).toBe(0);

    // New item should NOT reuse id 1 — must continue from 2
    const b = todo.createTodo('Task B');
    expect(b.id).toBe(2);
    expect(todo.getItems().length).toBe(1);
  });

  it('should not auto-clear when at least one item remains open', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.createTodo('Task B');

    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems().length).toBe(2);
    expect(todo.hasOpenTodo()).toBe(true);
  });

  it('should print "No todos." after auto-clear', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.printTodoList()).toBe('No todos.');
  });

  it('should reject update with stale hash after auto-clear', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    // list cleared — old reference should fail (id no longer found)
    const result = todo.updateTodo(a.id, a.hash, a.name, true);
    expect(result).toBeNull();
  });

  it('should compute hash as 8 hex chars based on name|done|note', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A', 'note text');
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/);
    // Same content → same hash
    const b = todo.createTodo('Task A', 'note text');
    expect(b.hash).toBe(a.hash);
    // Different note → different hash
    const c = todo.createTodo('Task A', 'different note');
    expect(c.hash).not.toBe(a.hash);
  });

  it('should recompute hash after an update', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', true);
    expect(updated!.hash).not.toBe(a.hash);
    // Re-updating with old hash fails (stale)
    expect(todo.updateTodo(a.id, a.hash, 'Renamed', true)).toBeNull();
  });

  it('clear() should reset both items and nextId', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    todo.clear();
    expect(todo.getItems().length).toBe(0);
    const b = todo.createTodo('Task B');
    expect(b.id).toBe(1);
  });

  it('should find and close checkpoint todos', () => {
    const todo = new Todo();
    todo.createTodo('checkpoint: abc12345', 'abc12345');
    expect(todo.findCheckpointTodo('abc12345')).not.toBeNull();
    todo.closeCheckpointTodo('abc12345');
    expect(todo.findCheckpointTodo('abc12345')).toBeNull();
  });

  // ── Pinned todos & reactivation ────────────────────────────────────────

  it('should NOT auto-clear pinned items when all todos are done', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');
    todo.pinTodo(b.id, b.hash, true);

    // Mark both done — non-pinned A is dropped, pinned B remains
    todo.updateTodo(a.id, a.hash, a.name, true);
    todo.updateTodo(b.id, b.hash, b.name, true);

    const items = todo.getItems();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(b.id);
    expect(items[0].pinned).toBe(true);
    expect(items[0].done).toBe(true);
  });

  it('should auto-clear normally when there are no pinned items (backward compat)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    todo.updateTodo(a.id, a.hash, a.name, true);
    todo.updateTodo(b.id, b.hash, b.name, true);

    expect(todo.getItems().length).toBe(0);
  });

  it('should keep an uncompleted pinned todo after non-pinned items complete', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const pinned = todo.createTodo('Reminder');
    todo.pinTodo(pinned.id, pinned.hash, true);

    // A done, pinned still open → A dropped, pinned remains open
    todo.updateTodo(a.id, a.hash, a.name, true);
    const items = todo.getItems();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(pinned.id);
    expect(items[0].done).toBe(false);
  });

  it('pinTodo should reject on id-not-found', () => {
    const todo = new Todo();
    const result = todo.pinTodo(999, 'deadbeef', true);
    expect(result).toBeNull();
  });

  it('pinTodo should reject on hash mismatch (anti-hallusion)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const result = todo.pinTodo(a.id, 'wronghash', true);
    expect(result).toBeNull();
    // Original item untouched
    expect(todo.getItems()[0].pinned).toBeUndefined();
  });

  it('pinTodo should set pinned and reactivate, without changing the hash', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const before = a.hash;
    const result = todo.pinTodo(a.id, a.hash, true, 'when base table changes');
    expect(result).not.toBeNull();
    expect(result!.pinned).toBe(true);
    expect(result!.reactivate).toBe('when base table changes');
    // Hash unchanged — pinned/reactivate are NOT part of the integrity signature
    expect(result!.hash).toBe(before);
  });

  it('un-pinning should clear reactivate', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.pinTodo(a.id, a.hash, true, 'when base table changes');
    const result = todo.pinTodo(a.id, todo.getItems()[0].hash, false);
    expect(result).not.toBeNull();
    expect(result!.pinned).toBe(false);
    expect(result!.reactivate).toBeUndefined();
  });

  it('getReactivationCandidates should return only pinned+done+reactivate items', () => {
    const todo = new Todo();
    todo.createTodo('Open task'); // not done
    const b = todo.createTodo('Done pinned w/ reactivate');
    const c = todo.createTodo('Done pinned w/o reactivate');
    const d = todo.createTodo('Done non-pinned w/ reactivate');
    todo.pinTodo(b.id, b.hash, true, 'cond-b');
    todo.pinTodo(c.id, c.hash, true);
    todo.pinTodo(d.id, d.hash, false, 'cond-d');
    todo.updateTodo(b.id, todo.getItems().find((i) => i.id === b.id)!.hash, b.name, true);
    todo.updateTodo(c.id, todo.getItems().find((i) => i.id === c.id)!.hash, c.name, true);
    todo.updateTodo(d.id, todo.getItems().find((i) => i.id === d.id)!.hash, d.name, true);

    const candidates = todo.getReactivationCandidates();
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe(b.id);
  });

  it('hasOpenTodo should be true when a completed pinned todo has a reactivation condition', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.pinTodo(a.id, a.hash, true, 'when X');
    todo.updateTodo(a.id, todo.getItems()[0].hash, a.name, true);
    // a is done + pinned + reactivate — counts as open for the nudge/reactivation pass
    expect(todo.hasOpenTodo()).toBe(true);
  });

  it('printTodoList should annotate pinned items with pin tag and reactivate condition', () => {
    const todo = new Todo();
    const a = todo.createTodo('Schema: users table');
    todo.pinTodo(a.id, a.hash, true, 'when users table changes');
    const printed = todo.printTodoList();
    expect(printed).toContain('📌');
    expect(printed).toContain('[reactivate: when users table changes]');
  });

  // ── Previous-hash lineage ring & warm-hint resolution ───────────────────
  //
  // The lineage ring records each todo's last 3 hashes so a stale hash the
  // LLM still holds can be resolved to the CURRENT item (for a warm hint)
  // WITHOUT accepting the stale write.

  it('should record the old hash in the lineage ring when updateTodo recomputes', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    // Companion open item keeps `a` alive when we flip it done (auto-clear
    // only drops non-pinned items once EVERY non-pinned item is done).
    todo.createTodo('Task B');
    const oldHash = a.hash;
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', true);
    expect(updated).not.toBeNull();
    const stored = todo.getItems().find((i) => i.id === a.id)!;
    expect(stored.previousHashes).toEqual([oldHash]);
  });

  it('should cap the lineage ring at 3 (oldest dropped first)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    // Companion open item so `a` is never auto-cleared (we keep done=false
    // throughout and only vary the name → the hash changes each iteration).
    todo.createTodo('Task B');
    const hashes: string[] = [a.hash];
    let cur = todo.getItems().find((i) => i.id === a.id)!.hash;
    // Drive 4 hash-changing updates (name-only) → ring keeps the last 3 olds.
    for (let i = 0; i < 4; i++) {
      const prev = cur;
      todo.updateTodo(a.id, cur, `name${i}`, false);
      cur = todo.getItems().find((i) => i.id === a.id)!.hash;
      hashes.push(prev);
    }
    const stored = todo.getItems().find((i) => i.id === a.id)!;
    // `hashes` = [h0, prev1, prev2, prev3, prev4] (initial + 4 pushed olds).
    // The ring keeps the 3 MOST-RECENT olds = [prev2, prev3, prev4]; the
    // oldest (prev1, which is h0 after the first rename) was shifted out.
    const expectedRing = hashes.slice(-3);
    expect(stored.previousHashes).toEqual(expectedRing);
    expect(stored.previousHashes!.length).toBe(3);
    // The very first old hash was evicted once the 5th distinct hash appeared.
    expect(stored.previousHashes).not.toContain(hashes[1]);
  });

  it('findByPreviousHash should resolve a stale hash to the CURRENT item', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    // Companion open item keeps `a` alive after the done flip below.
    todo.createTodo('Task B');
    const oldHash = a.hash;
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', true);
    expect(updated).not.toBeNull();
    const currentHash = updated!.hash;

    const resolved = todo.findByPreviousHash(oldHash);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(a.id);
    // Returns the CURRENT hash, not the stale one
    expect(resolved!.hash).toBe(currentHash);
    expect(resolved!.hash).not.toBe(oldHash);
  });

  it('findByPreviousHash should return null for a hash not in any ring (silent otherwise)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.createTodo('Task B');
    todo.updateTodo(a.id, a.hash, 'Renamed', false);
    expect(todo.findByPreviousHash('neverseen')).toBeNull();
  });

  it('should NOT push to the lineage ring on a no-op update (hash unchanged)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    // updateTodo with identical name|done|note → hash identical → no ring entry
    todo.updateTodo(a.id, a.hash, a.name, false);
    const stored = todo.getItems().find((i) => i.id === a.id)!;
    expect(stored.previousHashes ?? []).toEqual([]);
  });

  it('should still REJECT a stale write even when the lineage ring matches (integrity gate unchanged)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.createTodo('Task B');
    const oldHash = a.hash;
    todo.updateTodo(a.id, a.hash, 'Renamed', false);
    // Re-using the OLD hash must fail the integrity gate — the lineage ring
    // is observation-only metadata, never a second-chance update path.
    const result = todo.updateTodo(a.id, oldHash, 'Renamed again', false);
    expect(result).toBeNull();
  });

  it('closeCheckpointTodo should push the old hash into the lineage ring', () => {
    const todo = new Todo();
    const cp = todo.createTodo('checkpoint: abc12345', 'abc12345');
    // Companion open non-checkpoint item so closing the checkpoint does NOT
    // auto-clear it away (auto-clear only fires once EVERY non-pinned item is
    // done; the companion stays open).
    todo.createTodo('Companion open task');
    const oldHash = cp.hash;
    todo.closeCheckpointTodo('abc12345');
    const stored = todo.getItems().find((i) => i.note === 'abc12345')!;
    expect(stored.done).toBe(true);
    expect(stored.hash).not.toBe(oldHash);
    expect(stored.previousHashes).toEqual([oldHash]);
    // And the stale hash resolves to the (now done) current item
    const resolved = todo.findByPreviousHash(oldHash);
    expect(resolved).not.toBeNull();
    expect(resolved!.done).toBe(true);
  });
});