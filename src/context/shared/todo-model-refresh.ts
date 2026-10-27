import type { TodoModule } from '../../types.js';

const pending = new WeakSet<object>();

/** Queue a refresh for a todo change with no model-facing tool result. */
export function queueTodoModelRefresh(todo: TodoModule): void { pending.add(todo); }

/**
 * Consume the notification into the next successful brief result. This appends
 * to the transcript suffix and never rebuilds the cache-stable projectContext.
 * Multiple changes coalesce into the current authoritative list.
 */
export function takeTodoModelRefresh(todo: TodoModule): string | undefined {
  if (!pending.delete(todo)) return undefined;
  return ['[Out-of-band todo update]', 'Todo state changed outside a todo tool result. This is the current authoritative list; use the current hash for todo_update and todo_pinning.', todo.printTodoList()].join('\n\n');
}

/** Drop queued notices when the user starts a fresh session. */
export function discardTodoModelRefresh(todo: TodoModule): void { pending.delete(todo); }
