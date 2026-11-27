/**
 * todo_pinning.ts - Pin/unpin a todo, optionally with a STOP-GUARD condition
 *
 * Scope: ['main'] - Lead agent only. Teammates never see this tool, so they
 * cannot create pinned/guarded todos. The pin/guard capability is
 * intentionally lead-only because the STOP gate that evaluates the guard runs
 * only in the lead agent loop.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const todoPinningTool: ToolDefinition = {
  name: 'todo_pinning',
  description:
    'Pin or unpin a todo item. A regular (non-pinned) todo is ruled out the ' +
    'moment it is marked done, so the list only shows outstanding work. ' +
    'Pinned todos are NOT dropped on completion — they persist as long-term ' +
    'reminders. Optionally set ' +
    'a preventStop guard: a natural-language statement about the state the work ' +
    'must reach. While it holds, you cannot finish your turn — STOP sends you ' +
    'back to work with a SYSTEM note explaining what is still missing, so use it ' +
    'for conditions you must not forget to satisfy. Requires the current hash.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Todo item ID to pin/unpin'
      },
      hash: {
        type: 'string',
        description: 'Current hash of the item (from todo_create output or the todo list). Must match the stored hash.'
      },
      pinned: {
        type: 'boolean',
        description: 'true to pin (persist after completion), false to unpin'
      },
      preventStop: {
        type: 'string',
        description:
          'STOP-GUARD condition (only meaningful when pinned=true): a statement ' +
          'about the state the work must reach. While it holds you cannot end your ' +
          'turn — the system re-checks it at every STOP and sends you back to COLLECT. ' +
          'Example: "tests for the todo module pass and lint is clean".'
      }
    },
    required: ['id', 'hash', 'pinned']
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

    const updated = ctx.todo.pinTodo(id, hash.trim(), pinned, preventStop?.trim() || undefined);

    if (!updated) {
      const stillLive = ctx.todo.getItems().some((i) => i.id === id);
      if (!stillLive) {
        return (
          `Error: Todo item #${id} not found. A ruled-out (completed non-pinned) todo is removed ` +
          `from the list, and completion is irreversible — use the current todo list for a live id.`
        );
      }
      return `Error: Hash mismatch for todo #${id}. The item may have been updated since you last read it. Check the current todo list for the latest hash.`;
    }

    const action = pinned ? 'pinned' : 'unpinned';
    const guardInfo = updated.preventStop ? `\n  preventStop: ${updated.preventStop}` : '';
    ctx.core.brief('info', 'todo_pinning', ctx.todo.printTodoList(), `${action} #${updated.id}: ${updated.name}`);

    return `${action === 'pinned' ? 'Pinned' : 'Unpinned'} todo #${updated.id}
  name: ${updated.name}
  pinned: ${updated.pinned}${guardInfo}
  hash: ${updated.hash}`;
  }
};
