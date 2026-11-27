/**
 * todo.test.ts - Direct unit tests for the Todo class (not the tool wrapper)
 * Verifies hash integrity, ad-hoc retention (a completed non-pinned item is
 * ruled out immediately), and monotonic nextId.
 */

import { describe, it, expect } from 'vite-plus/test';
import { Todo } from '../../../context/shared/todo.js';

describe('Todo', () => {
  it('should rule out a completed item immediately (ad-hoc retention)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    // Mark A done — A is dropped NOW, B still open and still listed.
    const result = todo.updateTodo(a.id, a.hash, a.name, true);
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    const items = todo.getItems();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(b.id);
    expect(todo.hasOpenTodo()).toBe(true);
  });

  it('should keep nextId monotonic across a ruled-out item', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    // items now empty
    expect(todo.getItems().length).toBe(0);

    // New item should NOT reuse id 1 — must continue from 2
    const b = todo.createTodo('Task B');
    expect(b.id).toBe(2);
    expect(todo.getItems().length).toBe(1);
  });

  it('should keep other OPEN items when one is ruled out', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems().map((i) => i.id)).toEqual([b.id]);
    expect(todo.hasOpenTodo()).toBe(true);
  });

  it('should print "No todos." after the last item is ruled out', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.printTodoList()).toBe('No todos.');
  });

  it('should reject update with stale hash after the item was ruled out', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    // item ruled out — old reference should fail (id no longer found)
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
    // done=false so the item survives (a completed non-pinned item is ruled out)
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', false);
    expect(updated!.hash).not.toBe(a.hash);
    // Re-updating with old hash fails (stale)
    expect(todo.updateTodo(a.id, a.hash, 'Renamed', false)).toBeNull();
  });

  it('clear() should reset both items and nextId', () => {
    const todo = new Todo();
    todo.createTodo('Task A');
    todo.clear();
    expect(todo.getItems().length).toBe(0);
    const b = todo.createTodo('Task B');
    expect(b.id).toBe(1);
  });

  // ── Pinned todos & reactivation ────────────────────────────────────────

  it('should keep a COMPLETED pinned item when a regular one is ruled out', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');
    todo.pinTodo(b.id, b.hash, true);

    // Mark both done — non-pinned A is ruled out immediately, pinned B remains
    todo.updateTodo(a.id, a.hash, a.name, true);
    todo.updateTodo(b.id, todo.getItems().find((i) => i.id === b.id)!.hash, b.name, true);

    const items = todo.getItems();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(b.id);
    expect(items[0].pinned).toBe(true);
    expect(items[0].done).toBe(true);
  });

  it('should leave an empty list when every regular item is ruled out one by one', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const b = todo.createTodo('Task B');

    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems().map((i) => i.id)).toEqual([b.id]);
    todo.updateTodo(b.id, b.hash, b.name, true);

    expect(todo.getItems().length).toBe(0);
    expect(todo.printTodoList()).toBe('No todos.');
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

  it('pinTodo should set pinned and preventStop, without changing the hash', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const before = a.hash;
    const result = todo.pinTodo(a.id, a.hash, true, 'tests pass and lint is clean');
    expect(result).not.toBeNull();
    expect(result!.pinned).toBe(true);
    expect(result!.preventStop).toBe('tests pass and lint is clean');
    // Hash unchanged — pinned/preventStop are NOT part of the integrity signature
    expect(result!.hash).toBe(before);
  });

  it('un-pinning should clear preventStop', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.pinTodo(a.id, a.hash, true, 'tests pass');
    const result = todo.pinTodo(a.id, todo.getItems()[0].hash, false);
    expect(result).not.toBeNull();
    expect(result!.pinned).toBe(false);
    expect(result!.preventStop).toBeUndefined();
  });

  it('should RULE OUT a done item when it is un-pinned (no [x] ghost)', () => {
    // The hole this locks: pinTodo used to apply no retention rule, so
    // pin → done → unpin left a completed NON-pinned item in the list forever
    // (updateTodo's drop is unreachable once done, and hasOpenTodo() is false,
    // so collect's nudge never clears it). The STOP path tells the agent to
    // release guards with pinned=false, so this path is hit in normal use.
    const todo = new Todo();
    const a = todo.createTodo('Guard holder');
    todo.pinTodo(a.id, a.hash, true, 'tests pass');
    const pinned = todo.getItems()[0];
    todo.updateTodo(pinned.id, pinned.hash, pinned.name, true);
    expect(todo.getItems()).toHaveLength(1); // pinned + done survives

    const unpinned = todo.pinTodo(pinned.id, todo.getItems()[0].hash, false);
    expect(unpinned).not.toBeNull();
    expect(unpinned!.done).toBe(true);
    expect(unpinned!.pinned).toBe(false);
    expect(todo.getItems()).toHaveLength(0);
    expect(todo.printTodoList()).toBe('No todos.');
    expect(todo.hasOpenTodo()).toBe(false);
  });

  it('should keep an OPEN item when it is un-pinned (retention targets done only)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.pinTodo(a.id, a.hash, true, 'tests pass');
    const unpinned = todo.pinTodo(a.id, todo.getItems()[0].hash, false);
    expect(unpinned).not.toBeNull();
    expect(todo.getItems()).toHaveLength(1);
    expect(todo.getItems()[0].pinned).toBe(false);
    expect(todo.hasOpenTodo()).toBe(true);
  });

  it('should reject a stale write on a ruled-out id (gone, not resurrectable)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.updateTodo(a.id, a.hash, a.name, true);
    expect(todo.getItems()).toHaveLength(0);
    expect(todo.updateTodo(a.id, a.hash, 'Renamed', false)).toBeNull();
    expect(todo.pinTodo(a.id, a.hash, true)).toBeNull();
    expect(todo.getItems()).toHaveLength(0);
  });

  it('getPreventStopTodos returns pinned+guarded items regardless of done', () => {
    const todo = new Todo();
    const open = todo.createTodo('Open pinned w/ guard');
    const done = todo.createTodo('Done pinned w/ guard');
    const unguarded = todo.createTodo('Pinned w/o guard');
    const unpinned = todo.createTodo('Unpinned w/ guard');
    todo.pinTodo(open.id, open.hash, true, 'cond-open');
    todo.pinTodo(done.id, done.hash, true, 'cond-done');
    todo.pinTodo(unguarded.id, unguarded.hash, true);
    todo.pinTodo(unpinned.id, unpinned.hash, false, 'cond-unpinned');
    // Complete the second guarded item — a guard is about the state the work
    // must reach, so `done` must NOT filter it out.
    todo.updateTodo(done.id, todo.getItems().find((i) => i.id === done.id)!.hash, done.name, true);

    const guards = todo.getPreventStopTodos();
    expect(guards.map((g) => g.id)).toEqual([open.id, done.id]);
    expect(guards.every((g) => !!g.preventStop)).toBe(true);
  });

  it('hasOpenTodo ignores a guard: a guard blocks the END, not the work', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    todo.pinTodo(a.id, a.hash, true, 'when X');
    todo.updateTodo(a.id, todo.getItems()[0].hash, a.name, true);
    // Everything non-pinned is done, so there is no OPEN work left. The guard
    // is evaluated by STOP, not by the nudge, so it must not keep this true.
    expect(todo.hasOpenTodo()).toBe(false);
  });

  it('printTodoList should annotate pinned items with pin tag and the guard', () => {
    const todo = new Todo();
    const a = todo.createTodo('Schema: users table');
    todo.pinTodo(a.id, a.hash, true, 'schema is documented');
    const printed = todo.printTodoList();
    expect(printed).toContain('📌');
    expect(printed).toContain('[preventStop: schema is documented]');
  });

  // ── Previous-hash lineage ring & warm-hint resolution ───────────────────
  //
  // The lineage ring records each todo's last 3 hashes so a stale hash the
  // LLM still holds can be resolved to the CURRENT item (for a warm hint)
  // WITHOUT accepting the stale write.

  it('should record the old hash in the lineage ring when updateTodo recomputes', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const oldHash = a.hash;
    // done=false: a completed non-pinned item is ruled out, so the ring is
    // observed through a name-only update. The RETURNED copy is the record —
    // it must carry the ring even for an item that was dropped.
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', false);
    expect(updated).not.toBeNull();
    expect(updated!.previousHashes).toEqual([oldHash]);
    const stored = todo.getItems().find((i) => i.id === a.id)!;
    expect(stored.previousHashes).toEqual([oldHash]);
  });

  it('should carry the lineage ring on the returned copy of a RULED-OUT item', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    const oldHash = a.hash;
    const updated = todo.updateTodo(a.id, a.hash, a.name, true);
    expect(updated).not.toBeNull();
    expect(updated!.done).toBe(true);
    expect(updated!.previousHashes).toEqual([oldHash]);
    // …while the list no longer holds it
    expect(todo.getItems()).toHaveLength(0);
  });

  it('should cap the lineage ring at 3 (oldest dropped first)', () => {
    const todo = new Todo();
    const a = todo.createTodo('Task A');
    // done=false throughout: the item must survive to be a ring holder.
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
    const oldHash = a.hash;
    // done=false keeps the item alive (a completed non-pinned item is dropped).
    const updated = todo.updateTodo(a.id, a.hash, 'Renamed', false);
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
});
