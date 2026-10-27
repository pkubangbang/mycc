/**
 * todo.ts - Todo module: temporary checklist
 */

import { createHash } from 'crypto';
import { loopEvents, type TodoChangedPayload } from '../../loop/loop-events.js';
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
 * A caller-safe COPY of one item — the single place the copy contract is applied.
 *
 * WHY NOT `{ ...item }` (review M8): a shallow spread copies the `previousHashes`
 * ARRAY BY REFERENCE, so a caller that retains the returned item watches the ring
 * mutate under it later. `getItems()` documents exactly this hazard and deep-copies
 * the ring; the four mutation return values did not, so the contract held at one of
 * five sites. Routing every return through here means a new return site cannot
 * reopen the hole.
 *
 * "Absent stays absent — do not materialise an empty ring", matching getItems().
 */
function cloneItem(item: TodoItem): TodoItem {
  return {
    ...item,
    ...(item.previousHashes ? { previousHashes: [...item.previousHashes] } : {}),
  };
}

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
   * Announce the new list on the loop event bus.
   *
   * Emitting from INSIDE the mutation is the point: every path — the todo
   * tools, `/clear`, `/todos clear`, the double-Ctrl+L clear,
   * `recordRemotePeerTodo`, `tm_create`/`tm_remove`, `hand_over` — reaches the
   * bus without each call site remembering to emit, which is exactly how the
   * WebUI panel drifted out of sync before.
   *
   * COST: when nobody listens this is a single `Map` lookup; the list is
   * materialised only if `hasListeners('todo_changed')`. Without that guard
   * `getItems()` would allocate a full copy of every item on EVERY mutation —
   * including in a child process, which never serves and therefore never has a
   * subscriber. Locked by `todo-onchange.test.ts` ("does not materialise the
   * list when nobody listens", which spies on `getItems`).
   *
   * `getItems()` clones each item AND its `previousHashes` ring, so a listener
   * may retain the payload without seeing later mutations through an alias.
   */
  private emitChanged(source: TodoChangedPayload['source']): void {
    if (!loopEvents.hasListeners('todo_changed')) return;
    loopEvents.emit('todo_changed', { items: this.getItems(), source } satisfies TodoChangedPayload);
  }

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
    this.emitChanged('create');
    return cloneItem(item);
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
    const autoCleared = this.items.length > 0 && this.items.filter((i) => !i.pinned).every((i) => i.done);
    if (autoCleared) {
      this.items = this.items.filter((i) => i.pinned);
    }

    // Report the PURGE distinctly from the EDIT (review B6): when the auto-clear
    // just removed the very item this call updated, returning it unchanged would
    // hand the caller a GHOST — a successful result for a row the store no longer
    // holds, whose hash can never be used again (findByPreviousHash scans
    // `this.items`, and the recap's `formatOpenTodos` filters done non-pinned
    // rows, so the item never re-enters the model's context either).
    //
    // The RETURN SHAPE is kept deliberately (a `TodoItem`, exactly as before):
    // `updateTodo` is a shared API with several callers, and returning null here
    // broke them all for a defect that is really about what the TOOL tells the
    // model. So the purge is announced on the event bus instead, where a
    // subscriber that renders the list can see it, and the caller decides what to
    // say — `todo_update` compares the returned item against the live list.
    this.emitChanged(autoCleared ? 'autoclear' : 'update');
    return cloneItem(existing);
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
    // nextId is deliberately NOT reset: ids must stay unique for the whole
    // session. The auto-clear in updateTodo() documents the same rule — the
    // LLM may still hold a hash/id reference for a now-cleared item, and the
    // WebUI uses the id as a row key, so reusing #1 after a clear would both
    // collide with the stale row and resurrect a dead reference.
    this.emitChanged('clear');
  }

  /**
   * Get all items (for testing)
   */
  getItems(): TodoItem[] {
    return this.items.map((i) => ({
      ...i,
      // Deep-ish copy: the lineage ring is a mutable array shared with the live
      // item, so a shallow spread would let a retained snapshot observe LATER
      // mutations (the bus payload's `previousHashes` grew after it was
      // emitted). Absent stays absent — do not materialise an empty ring.
      ...(i.previousHashes ? { previousHashes: [...i.previousHashes] } : {}),
    }));
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
    return cloneItem(item);
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
