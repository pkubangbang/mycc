/**
 * /todos command - Print todo list
 */

import type { SlashCommand } from '../types.js';

export const todosCommand: SlashCommand = {
  name: 'todos',
  description: 'Print todo list',
  handler: (context) => {
    console.log(context.ctx.todo.printTodoList());
  },
};