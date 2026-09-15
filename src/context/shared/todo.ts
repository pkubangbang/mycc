/**
 * todo.ts - Todo module: temporary checklist
 */

import { createHash } from 'crypto';
import type { TodoModule, TodoItem } from '../../types.js';

/**
 * Compute integrity hash for a todo item
 * hash = SHA256(name|done|note) → first 8 hex chars
 */
function computeHash(name: string, done: boolean, note?: string): string {
  const payload = `${name}|${done}|${note ?? ''}`;
  return createHash('sha256').update(payload).digest('hex').substring(0, 8);
}

/** Maximum number of previous hashes retained per item (lineage ring cap). */
const LINEAGE_RING_CAP = 3;

/**
 * Record the item's CURRENT hash in its lineage ring (cap 3, oldest dropped
 * first), in-place on `item.previousHashes`. Call AFTER computing the new
 * hash but BEFORE assigning it to `item.hash`, passing the new hash in
 * `newHash`. A no-op when the hash does not actually change (identical
 * name|done|note), keeping the ring meaningful.
 *
 * Observation-only metadata: the ring is read by `findByPreviousHash` to
 * resolve a stale hash to the current item for a warm hint; it never gates a
 * write (the integrity check in `updateTodo`/`pinTodo` is unchanged).
 */
function pushPreviousHash(item: TodoItem, newHash: string): void {
  if (newHash === item.hash) return; // no-op transition, hash unchanged
  const ring = item.previousHashes ?? [];
  ring.push(item.hash);
  while (ring.length > LINEAGE_RING_CAP) {
    ring.shift();
  }
  item.previousHashes = ring;
}

/**
 * Todo module implementation
 */
export class Todo implements TodoModule {
  private items: TodoItem[] = [];
  private nextId: number = 1;

  /**
   * Create a new todo item
   * Assigns auto-increment id and computes integrity hash
   */
  createTodo(name: string, note?: string): TodoItem {
    const id = this.nextId++;
    const done = false;
    const hash = computeHash(name, done, note);
    const item: TodoItem = { id, name, done, note, hash };
    this.items.push(item);
    return { ...item };
  }

  /**
   * Update an existing todo item by id
   * Validates the provided hash matches the stored hash.
   * Returns null if id not found or hash mismatch.
   */
  updateTodo(id: number, hash: string, name: string, done: boolean, note?: string): TodoItem | null {
    const existing = this.items.find((i) => i.id === id);
    if (!existing) {
      return null;
    }

    // Hash must match — prevents stale/mangled updates
    if (existing.hash !== hash) {
      return null;
    }

    // Update fields and recompute hash
    existing.name = name;
    existing.done = done;
    existing.note = note;
    // Record the pre-update hash in the lineage ring (cap 3) BEFORE assigning
    // the new one, so a stale hash the LLM still holds can be resolved to this
    // item via findByPreviousHash. Observation-only — does not accept the
    // stale write (the gate above already rejected it if it didn't match).
    const newHash = computeHash(name, done, note);
    pushPreviousHash(existing, newHash);
    existing.hash = newHash;

    // Auto-clear: when every NON-PINNED item is done, drop only the non-pinned
    // items so the prompt stops showing a fully-checked checklist of ephemeral
    // work. Pinned items (done or not) always remain — they are long-term
    // reminders that survive completion. Keep nextId monotonic across the
    // session so IDs never collide with prior (now-cleared) hash references
    // the LLM may still hold in the triologue.
    if (this.items.length > 0 && this.items.filter((i) => !i.pinned).every((i) => i.done)) {
      this.items = this.items.filter((i) => i.pinned);
    }

    return { ...existing };
  }

  /**
   * Format todo list for prompt
   */
  printTodoList(): string {
    if (this.items.length === 0) {
      return 'No todos.';
    }

    const lines = ['Todo list:'];
    for (const item of this.items) {
      const marker = item.done ? '[x]' : '[ ]';
      const pinTag = item.pinned ? '📌' : '';
      const reactTag = item.reactivate ? ` [reactivate: ${item.reactivate}]` : '';
      const note = item.note ? ` (${item.note})` : '';
      lines.push(`  ${marker} ${pinTag} ${item.id}. ${item.name}${note}${reactTag} [hash: ${item.hash}]`);
    }
    return lines.join('\n');
  }

  /**
   * Check if there are incomplete todos, OR completed pinned todos carrying a
   * reactivation condition (candidates for auto-reactivation). The latter
   * keeps the nudge/reactivation pass firing for pinned todos that may need
   * to be reopened.
   */
  hasOpenTodo(): boolean {
    return this.items.some((item) => !item.done) ||
           this.items.some((item) => item.pinned && item.done && !!item.reactivate);
  }

  /**
   * Clear all todos
   */
  clear(): void {
    this.items = [];
    this.nextId = 1;
  }

  /**
   * Get all items (for testing)
   */
  getItems(): TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * Find the todo item auto-created for a checkpoint.
   * Checkpoint todos have note === checkpointId.
   * Returns null if not found or already done.
   */
  findCheckpointTodo(checkpointId: string): TodoItem | null {
    const item = this.items.find((i) => i.note === checkpointId);
    if (!item || item.done) return null;
    return { ...item };
  }

  /**
   * Close the todo item auto-created for a checkpoint.
   * Marks it as done. Best-effort — no error if not found.
   */
  closeCheckpointTodo(checkpointId: string): void {
    const item = this.items.find((i) => i.note === checkpointId && !i.done);
    if (item) {
      // done flips false→true, so the hash changes — record the old one first.
      const newHash = computeHash(item.name, true, item.note);
      pushPreviousHash(item, newHash);
      item.done = true;
      item.hash = newHash;
    }
  }

  /**
   * Pin or unpin a todo item, optionally setting a natural-language
   * reactivation condition. Requires the current hash (anti-hallusion) —
   * rejects if id not found or hash mismatch. The hash is NOT recomputed:
   * pinned/reactivate are not part of the integrity signature.
   * @returns the updated item (copy), or null on id-not-found / hash mismatch
   */
  pinTodo(id: number, hash: string, pinned: boolean, reactivate?: string): TodoItem | null {
    const existing = this.items.find((i) => i.id === id);
    if (!existing) return null;
    if (existing.hash !== hash) return null;

    existing.pinned = pinned;
    // Clear reactivate when un-pinning; set/overwrite when pinning.
    existing.reactivate = pinned ? reactivate : undefined;
    return { ...existing };
  }

  /**
   * Resolve a stale hash to the CURRENT item whose lineage ring contains it.
   * Scans `this.items` for one whose `previousHashes` includes `hash` and
   * returns a copy of that item (carrying its CURRENT hash). Returns null if
   * no item's lineage ring contains the hash.
   *
   * Observation-only: never mutates state, never accepts a stale write. Used
   * by `todo_update` to emit a warm hint with the current hash on a lineage
   * match; the integrity gate in `updateTodo` is unchanged.
   */
  findByPreviousHash(hash: string): TodoItem | null {
    const item = this.items.find((i) => i.previousHashes?.includes(hash));
    if (!item) return null;
    return { ...item };
  }

  /**
   * Completed pinned todos carrying a reactivation condition — candidates
   * for auto-reactivation. The COLLECT state evaluates each candidate's
   * condition against the conversation context via `forkChat` and reopens
   * those whose condition is met.
   */
  getReactivationCandidates(): TodoItem[] {
    return this.items
      .filter((i) => i.pinned && i.done && !!i.reactivate)
      .map((i) => ({ ...i }));
  }
}
