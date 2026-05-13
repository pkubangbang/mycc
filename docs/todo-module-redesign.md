# Todo Module Redesign

## Motivation

The existing `todo_write` tool with `patchTodoList` is too broad — it handles both creation and update of multiple items in a single call. LLMs perform poorly with "multiple things at a time". The hand_over tool and checkpoint/recap system also "play magic" by auto-updating todo items, which violates separation of concerns.

## Design Principles

1. **Single-item operations**: `todo_create` and `todo_update` each handle ONE item
2. **Hash integrity**: Every item has `hash = SHA256(name|done|note)`. The LLM must provide the matching hash in `todo_update` to prevent stale/mangled updates
3. **No magic**: No non-todo code auto-creates or auto-marks todo items. The LLM manages todos explicitly via the nudging cycle
4. **Keep `printTodoList`**: Auto-injected by the agent routine for alignment

## API

### `todo_create`

```
Input:  { name: string, note?: string }
Output: { id: number, name: string, done: false, note?: string, hash: string }
```

Creates a new todo item. Returns the item with auto-assigned `id` and integrity `hash`.

### `todo_update`

```
Input:  { id: integer, hash: string, name: string, done: boolean, note?: string }
Output: Updated TodoItem, or error on hash mismatch / id not found
```

Updates an existing item. The provided `hash` must match the stored hash — this proves the LLM has the current state and prevents stale updates.

### Hash Algorithm

```
hash = SHA256(name + "|" + done + "|" + (note ?? "")) → first 8 hex chars
```

### Display Format (`printTodoList`)

```
Todo list:
  [x] 1. item name (note) [hash: a1b2c3d4]
  [ ] 2. another item [hash: e5f6g7h8]
```

The hash is shown so the LLM can read it back in `todo_update`.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | Edit | Update `TodoItem` (id required, +hash), `TodoModule` (createTodo/updateTodo) |
| `src/context/shared/todo.ts` | Rewrite | New Todo class with createTodo, updateTodo, hash computation |
| `src/tools/todo_write.ts` | Delete | Replaced by two focused tools |
| `src/tools/todo_create.ts` | Create | Single-item creation tool |
| `src/tools/todo_update.ts` | Create | Single-item update with hash validation |
| `src/context/shared/loader.ts` | Edit | Register todo_create, todo_update |
| `src/loop/checkpoint-recap.ts` | Edit | Remove all todo auto-updates |
| `src/loop/states/hook.ts` | Edit | Remove todo from checkpoint context |
| `src/tools/hand_over.ts` | Edit | Remove all todo auto-updates |
| `src/loop/states/tool.ts` | Edit | Update ACTION_TOOLS set |
| `src/context/teammate-worker.ts` | Edit | Update ACTION_TOOLS, nudging text |
| `src/loop/states/collect.ts` | Edit | Update nudging text |
| `src/loop/agent-prompts.ts` | Edit | Update tool references |
| `src/tests/tools/todo-basics.test.ts` | Delete | Replaced |
| `src/tests/tools/todo-validation.test.ts` | Delete | Replaced |
| `src/tests/tools/todo-create.test.ts` | Create | Tests for todo_create |
| `src/tests/tools/todo-update.test.ts` | Create | Tests for todo_update |

## Removed Anti-Patterns

1. **`hand_over.ts`** — No longer auto-creates or auto-marks todo items. The LLM manages its own todos.
2. **`checkpoint-recap.ts`** — No longer auto-creates a todo on checkpoint or auto-marks it done on recap. The LLM calls `todo_create`/`todo_update` explicitly.
3. **`patchTodoList`** — Completely removed. Replaced by focused single-item operations.
