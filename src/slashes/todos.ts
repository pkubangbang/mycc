/**
 * /todos command - Print todo list, or clear all todos
 *
 * Usage:
 *   /todos        - Print todo list
 *   /todos clear  - Clear all todos
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const todosCommand: SlashCommand = {
  name: 'todos',
  description: 'Print todo list (/todos [clear])',
  aliases: ['todo'],
  handler: (context) => {
    const subCommand = context.args[1];

    if (subCommand === 'clear') {
      context.ctx.todo.clear();
      console.log(chalk.green('All todos cleared.'));
    } else if (!subCommand) {
      console.log(chalk.cyan('\n=== Todos ===\n'));
      console.log(context.ctx.todo.printTodoList());
      console.log(chalk.gray('\nSubcommands:'));
      console.log(chalk.gray('  /todos clear   Clear all todos'));
    } else {
      console.log(chalk.yellow(`Unknown subcommand: ${subCommand}`));
      console.log(chalk.gray('Available: clear'));
    }
  },
};
