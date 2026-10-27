/**
 * todo_pinning.ts - Pin/unpin a todo, optionally with a stop guard
 *
 * Scope: ['main'] - Lead agent only. Teammates never see this tool, so they
 * cannot create pinned/guarded todos. The pin/guard capability is
 * intentionally lead-only because the guard evaluation (forkChat in the
 * STOP state) only runs in the lead agent loop.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { sanitizeTodoField, renderTodoItemDetails } from '../context/shared/todo-render.js';

export const todoPinningTool: ToolDefinition = {
  name: 'todo_pinning',
  description:
    'Pin or unpin a todo item. Pinned todos are NOT auto-cleared when all ' +
    'todos are completed — they persist as long-term reminders. Optionally set ' +
    'a stop guard: while that condition still holds you are not allowed to ' +
    'finish your turn — the turn continues with a note explaining why. Omit ' +
    'the guard (or unpin) to allow the turn to end. Requires the current hash.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Todo item ID to pin/unpin',
      },
      hash: {
        type: 'string',
        description: 'Current hash of the item (from todo_create output or the todo list). Must match the stored hash.',
      },
      pinned: {
        type: 'boolean',
        description: 'true to pin (persist after completion), false to unpin (also clears the guard)',
      },
      preventStop: {
        type: 'string',
        description:
          'Stop guard (only meaningful when pinned=true): a natural-language ' +
          'condition. While it still holds you cannot finish your turn — the ' +
          'turn continues with a note naming the reason. Unpin to release it. ' +
          'Example: "until every test under src/loop passes".',
      },
    },
    required: ['id', 'hash', 'pinned'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const id = args.id as number;
    const hash = args.hash as string;
    const pinned = args.pinned as boolean;
    const preventStop = args.preventStop as string | undefined;

    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return 'Error: id must be a positive integer.';
    }
    if (!hash || typeof hash !== 'string' || hash.trim() === '') {
      return 'Error: hash is required and must be a non-empty string.';
    }
    if (typeof pinned !== 'boolean') {
      return 'Error: pinned must be a boolean.';
    }
    // preventStop is optional, but when provided must be a non-empty string
    if (preventStop !== undefined && (typeof preventStop !== 'string' || preventStop.trim() === '')) {
      return 'Error: preventStop must be a non-empty string when provided.';
    }

    const updated = ctx.todo.pinTodo(
      id,
      hash.trim(),
      pinned,
      preventStop?.trim() || undefined,
    );

    if (!updated) {
      const items = ctx.todo.getItems();
      const exists = items.some((i) => i.id === id);
      if (!exists) {
        return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      }
      const current = items.find((i) => i.id === id)!;
      return `Error: Hash mismatch for todo #${id}. No changes were applied.\nCurrent item:\n${renderTodoItemDetails(current)}\nRetry using the current hash above.`;
    }

    const action = pinned ? 'pinned' : 'unpinned';
    const safeName = sanitizeTodoField(updated.name) ?? '(unnamed)';
    const safeGuard = sanitizeTodoField(updated.preventStop);
    const guardInfo = safeGuard ? `\n  preventStop: ${safeGuard}` : '';
    // Same rule as todo_create/todo_update: no open-list echo — the list is
    // delivered by the todo project-context populator (buildTodoMessages).
    ctx.core.brief(
      'info',
      'todo_pinning',
      `${action} #${updated.id}: ${safeName}`,
    );

    return `${action === 'pinned' ? 'Pinned' : 'Unpinned'} todo #${updated.id}
  name: ${safeName}
  pinned: ${updated.pinned}${guardInfo}
  hash: ${updated.hash}`;
  },
};