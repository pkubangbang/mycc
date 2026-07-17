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
    existing.hash = computeHash(name, done, note);

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
      item.done = true;
      item.hash = computeHash(item.name, true, item.note);
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
