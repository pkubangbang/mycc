/**
 * todo_create.ts - Create a new todo item
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const todoCreateTool: ToolDefinition = {
  name: 'todo_create',
  description: 'Create a new todo item. Returns the item with its id and hash — save these to reference the item later with todo_update.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Todo item name/description',
      },
      note: {
        type: 'string',
        description: 'Optional note for the item',
      },
    },
    required: ['name'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    const note = args.note as string | undefined;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return 'Error: name is required and must be a non-empty string.';
    }

    const item = ctx.todo.createTodo(name.trim(), note?.trim() || undefined);
    ctx.core.brief('info', 'todo_create', ctx.todo.printTodoList(), `Created #${item.id}: ${item.name}`);

    return `Created todo #${item.id}
  name: ${item.name}
  done: false${item.note ? `\n  note: ${item.note}` : ''}
  hash: ${item.hash}

${ctx.todo.printTodoList()}`;
  },
};
