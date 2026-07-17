/**
 * todo_pinning.ts - Pin/unpin a todo, optionally with a reactivation condition
 *
 * Scope: ['main'] - Lead agent only. Teammates never see this tool, so they
 * cannot create pinned/reactivate todos. The pin/reactivate capability is
 * intentionally lead-only because the reactivation evaluation (forkChat in
 * the COLLECT state) only runs in the lead agent loop.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const todoPinningTool: ToolDefinition = {
  name: 'todo_pinning',
  description:
    'Pin or unpin a todo item. Pinned todos are NOT auto-cleared when all ' +
    'todos are completed — they persist as long-term reminders. Optionally ' +
    'set a reactivation condition (natural language): after each nudge cycle ' +
    'the system evaluates completed pinned todos against the conversation ' +
    'context and automatically reactivates (marks back to not done) those ' +
    'whose condition is met. Requires the current hash (anti-hallusion).',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Todo item ID to pin/unpin',
      },
      hash: {
        type: 'string',
        description:
          'Current hash of the item (from todo_create output or the todo list). ' +
          'Must match the stored hash or the operation is rejected.',
      },
      pinned: {
        type: 'boolean',
        description: 'true to pin (persist after completion), false to unpin',
      },
      reactivate: {
        type: 'string',
        description:
          'Natural-language reactivation condition. Only meaningful when ' +
          'pinned=true. When the system detects this condition is met in the ' +
          'conversation context, the todo is automatically marked back to not ' +
          'done. Example: "when the users table is modified (INSERT/UPDATE/DELETE)"',
      },
    },
    required: ['id', 'hash', 'pinned'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const id = args.id as number;
    const hash = args.hash as string;
    const pinned = args.pinned as boolean;
    const reactivate = args.reactivate as string | undefined;

    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return 'Error: id must be a positive integer.';
    }
    if (!hash || typeof hash !== 'string' || hash.trim() === '') {
      return 'Error: hash is required and must be a non-empty string.';
    }
    if (typeof pinned !== 'boolean') {
      return 'Error: pinned must be a boolean.';
    }
    // reactivate is optional, but when provided must be a non-empty string
    if (reactivate !== undefined && (typeof reactivate !== 'string' || reactivate.trim() === '')) {
      return 'Error: reactivate must be a non-empty string when provided.';
    }

    const updated = ctx.todo.pinTodo(
      id,
      hash.trim(),
      pinned,
      reactivate?.trim() || undefined,
    );

    if (!updated) {
      const items = ctx.todo.getItems();
      const exists = items.some((i) => i.id === id);
      if (!exists) {
        return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      }
      return `Error: Hash mismatch for todo #${id}. The item may have been updated since you last read it. Check the current todo list for the latest hash.`;
    }

    const action = pinned ? 'pinned' : 'unpinned';
    const reactivateInfo = updated.reactivate ? `\n  reactivate: ${updated.reactivate}` : '';
    ctx.core.brief(
      'info',
      'todo_pinning',
      ctx.todo.printTodoList(),
      `${action} #${updated.id}: ${updated.name}`,
    );

    return `${action === 'pinned' ? 'Pinned' : 'Unpinned'} todo #${updated.id}
  name: ${updated.name}
  pinned: ${updated.pinned}${reactivateInfo}
  hash: ${updated.hash}

${ctx.todo.printTodoList()}`;
  },
};