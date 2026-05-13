/**
 * todo_update.ts - Update an existing todo item
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const todoUpdateTool: ToolDefinition = {
  name: 'todo_update',
  description: 'Update an existing todo item by id. You MUST provide the item\'s current hash — the update will be rejected if the hash doesn\'t match (prevents stale updates). Get the hash from todo_create output or the todo list display.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Item ID to update',
      },
      hash: {
        type: 'string',
        description: 'Current hash of the item (from todo_create output or todo list). Must match stored hash or update is rejected.',
      },
      name: {
        type: 'string',
        description: 'Todo item name/description',
      },
      done: {
        type: 'boolean',
        description: 'Whether the item is completed',
      },
      note: {
        type: 'string',
        description: 'Optional note for the item',
      },
    },
    required: ['id', 'hash', 'name', 'done'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const id = args.id as number;
    const hash = args.hash as string;
    const name = args.name as string;
    const done = args.done as boolean;
    const note = args.note as string | undefined;

    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return 'Error: id must be a positive integer.';
    }

    if (!hash || typeof hash !== 'string' || hash.trim() === '') {
      return 'Error: hash is required and must be a non-empty string.';
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return 'Error: name is required and must be a non-empty string.';
    }

    if (typeof done !== 'boolean') {
      return 'Error: done must be a boolean.';
    }

    const updated = ctx.todo.updateTodo(id, hash.trim(), name.trim(), done, note?.trim() || undefined);

    if (!updated) {
      // Check if id doesn't exist vs hash mismatch
      const items = ctx.todo.getItems();
      const exists = items.some((i) => i.id === id);
      if (!exists) {
        return `Error: Todo item #${id} not found. Use the current todo list to find the correct id.`;
      }
      return `Error: Hash mismatch for todo #${id}. The item may have been updated since you last read it. Check the current todo list for the latest hash.`;
    }

    const status = updated.done ? 'completed' : 'updated';
    ctx.core.brief('info', 'todo_update', ctx.todo.printTodoList(), `${status} #${updated.id}: ${updated.name}`);

    return `Updated todo #${updated.id}
  name: ${updated.name}
  done: ${updated.done}${updated.note ? `\n  note: ${updated.note}` : ''}
  hash: ${updated.hash}

${ctx.todo.printTodoList()}`;
  },
};
