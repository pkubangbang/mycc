# Todo Module Redesign

> **Status:** Implemented. Core API (todo_create/todo_update with hash integrity) shipped as designed. The "No magic" principle was partially relaxed — see "Anti-patterns" below. A later addition (`todo_pinning` tool + `pinned`/`reactivate` fields) extended the module beyond the original design.

## Motivation

The existing `todo_write` tool with `patchTodoList` was too broad — it handled both creation and update of multiple items in a single call. LLMs perform poorly with "multiple things at a time". The hand_over tool and checkpoint/recap system also "play magic" by auto-updating todo items, which violates separation of concerns.

## Design Principles

1. **Single-item operations**: `todo_create` and `todo_update` each handle ONE item
2. **Hash integrity**: Every item has `hash = SHA256(name|done|note)`. The LLM must provide the matching hash in `todo_update` to prevent stale/mangled updates
3. **Keep `printTodoList`**: Auto-injected by the agent routine for alignment

## API

### `todo_create`

```
Input:  { name: string, note?: string }
Output: { id: number, name: string, done: false, note?: string, hash: string }
```

Creates a new todo item. Returns the item with auto-assigned `id` and integrity `hash`.

**Tool file**: `src/tools/todo_create.ts` — scope `['main', 'child']`

### `todo_update`

```
Input:  { id: integer, hash: string, name: string, done: boolean, note?: string }
Output: Updated TodoItem, or error on hash mismatch / id not found
```

Updates an existing item. The provided `hash` must match the stored hash — this proves the LLM has the current state and prevents stale updates.

**Tool file**: `src/tools/todo_update.ts` — scope `['main', 'child']`

### `todo_pinning` (added after initial redesign)

```
Input:  { id: integer, hash: string, pinned: boolean, reactivate?: string }
Output: Updated TodoItem, or null on id-not-found / hash mismatch
```

Pin or unpin a todo item, optionally setting a natural-language reactivation condition. Requires the current hash (anti-hallusion). The hash is NOT recomputed — `pinned`/`reactivate` are not part of the integrity signature.

**Tool file**: `src/tools/todo_pinning.ts` — scope `['main']` (lead-only)

Pinned todos are NOT auto-cleared when all non-pinned todos are completed. They persist as long-term reminders. Completed pinned todos with a `reactivate` condition are evaluated each nudge cycle via `forkChat`; if the condition is met, the todo is automatically reopened.

### Hash Algorithm

```
hash = SHA256(name + "|" + done + "|" + (note ?? "")) → first 8 hex chars
```

The hash deliberately excludes `pinned` and `reactivate` — these are managed through `todo_pinning`, which itself requires the current hash, so the anti-hallusion guarantee is preserved.

### Display Format (`printTodoList`)

```
Todo list:
  [x] 📌 1. item name (note) [reactivate: when tests pass] [hash: a1b2c3d4]
  [ ] 2. another item [hash: e5f6g7h8]
```

The hash is shown so the LLM can read it back for `todo_update`. Pinned items show 📌. Items with a reactivation condition show `[reactivate: ...]`.

## TodoItem Interface

```typescript
interface TodoItem {
  id: number;       // auto-assigned, monotonic across the session
  name: string;
  done: boolean;
  note?: string;
  hash: string;     // SHA256(name|done|note), first 8 hex chars
  pinned?: boolean;          // set via todo_pinning
  reactivate?: string;       // natural-language reactivation condition (pinned only)
}
```

## TodoModule Interface

```typescript
interface TodoModule {
  createTodo(name: string, note?: string): TodoItem;
  updateTodo(id: number, hash: string, name: string, done: boolean, note?: string): TodoItem | null;
  printTodoList(): string;
  hasOpenTodo(): boolean;
  clear(): void;
  getItems(): TodoItem[];
  findCheckpointTodo(checkpointId: string): TodoItem | null;
  closeCheckpointTodo(checkpointId: string): void;
  pinTodo(id: number, hash: string, pinned: boolean, reactivate?: string): TodoItem | null;
  getReactivationCandidates(): TodoItem[];
}
```

**Implementation**: `src/context/shared/todo.ts` — `Todo` class.

`hasOpenTodo()` returns true if there are incomplete items OR completed pinned items with a reactivation condition (candidates for auto-reactivation).

Auto-clear: when every non-pinned item is done, only non-pinned items are dropped. Pinned items always remain. `nextId` stays monotonic across the session so IDs never collide with prior cleared hash references.

## Removed

1. **`todo_write.ts`** — Deleted. Replaced by `todo_create` and `todo_update`.
2. **`patchTodoList`** — Completely removed. Replaced by focused single-item operations.
3. **Old test files** (`todo-basics.test.ts`, `todo-validation.test.ts`) — Replaced by `todo-create.test.ts` and `todo-update.test.ts`.

## Anti-patterns (partially retained)

The original design called for removing ALL auto-creation/auto-marking of todos from non-todo code. In practice, two auto-creation sites were retained:

1. **`checkpoint-recap.ts`** (line ~129) — Still auto-creates a todo item when a checkpoint is created: `ctx.todo.createTodo(\`Checkpoint: ${description}\`, id)`. The todo's `note` field stores the checkpoint ID. On recap, `closeCheckpointTodo(checkpointId)` auto-marks it done. This coupling was kept because checkpoint todos serve as visible progress markers that the LLM sees in every nudge cycle.

2. **`hand_over.ts`** (line ~180) — Still auto-creates a todo when a tmux session is handed over: `ctx.todo.createTodo(\`hand_over: [sessionName: ${sessionName}]\`, command)`. This tracks the handed-over session as an open task.

These are intentional exceptions to the "No magic" principle — they create todos for system-level events that the LLM would not naturally track on its own.