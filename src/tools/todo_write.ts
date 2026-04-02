/**
 * todo_write.ts - Update todo list
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext, TodoItem } from '../types.js';

export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description: 'Update the todo list with new items or modify existing items. Merges changes into the current todo list.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Array of todo items to add or update',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              description: 'Item ID (0 or undefined for new items, existing ID to update)',
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
          required: ['name'],
        },
      },
    },
    required: ['items'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const items = args.items as Array<Record<string, unknown>>;

    if (!Array.isArray(items) || items.length === 0) {
      return 'Error: items must be a non-empty array';
    }

    // Transform and validate items
    const todoItems: TodoItem[] = items.map((item) => ({
      id: (item.id as number) || 0,
      name: item.name as string,
      done: (item.done as boolean) || false,
      note: item.note as string | undefined,
    }));

    // Update todo list
    ctx.todo.patchTodoList(todoItems);

    // Log the action
    const action = todoItems.every((item) => item.done) ? 'completed' : 'updated';
    const summary = todoItems.map((item) =>
      `  ${item.done ? '✓' : '○'} ${item.name}${item.note ? `: ${item.note}` : ''}`
    ).join('\n');
    ctx.core.brief('info', 'todo_write', `${todoItems.length} item(s) ${action}:\n${summary}`);

    // Return current todo list
    return ctx.todo.printTodoList();
  },
};