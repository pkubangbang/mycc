/**
 * /todos command - Manage todos
 *
 * Usage:
 *   /todos                  - Print todo list
 *   /todos add <name> [-n <note>]  - Add a new todo
 *   /todos clear            - Clear all todos
 *   /todos done <id> [note]     - Mark a todo as done
 *   /todos undone <id> [note]   - Mark a todo as not done
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const todosCommand: SlashCommand = {
  name: 'todos',
  description: 'Manage todos (/todos [add|clear|done|undone])',
  aliases: ['todo'],
  handler: (context) => {
    const subCommand = context.args[1];

    if (subCommand === 'add') {
      // Parse name and optional -n/--note
      const rest = context.args.slice(2);
      let noteIndex = -1;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-n' || rest[i] === '--note') {
          noteIndex = i;
          break;
        }
      }

      let name: string;
      let note: string | undefined;
      if (noteIndex >= 0) {
        name = rest.slice(0, noteIndex).join(' ');
        note = rest.slice(noteIndex + 1).join(' ') || undefined;
      } else {
        name = rest.join(' ');
      }

      if (!name.trim()) {
        console.log(chalk.red('Usage: /todos add <name> [-n <note>]'));
        return;
      }

      const item = context.ctx.todo.createTodo(name.trim(), note);
      const noteStr = note ? ` (note: ${note})` : '';
      console.log(chalk.green(`Todo ${item.id} added: ${item.name}${noteStr} [hash: ${item.hash}]`));
    } else if (subCommand === 'clear') {
      context.ctx.todo.clear();
      console.log(chalk.green('All todos cleared.'));
    } else if (subCommand === 'done' || subCommand === 'undone') {
      const idStr = context.args[2];
      const note = context.args.slice(3).join(' ') || undefined;
      const done = subCommand === 'done';

      if (!idStr) {
        console.log(chalk.red(`Usage: /todos ${subCommand} <id> [note]`));
        return;
      }

      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.log(chalk.red(`Invalid id: ${idStr}`));
        return;
      }

      const items = context.ctx.todo.getItems();
      const item = items.find((i) => i.id === id);
      if (!item) {
        console.log(chalk.yellow(`Todo ${id} not found.`));
        return;
      }

      const updated = context.ctx.todo.updateTodo(
        id,
        item.hash,
        item.name,
        done,
        note ?? item.note,
      );

      if (updated) {
        const status = done ? 'done' : 'undone';
        console.log(chalk.green(`Todo ${id} marked as ${status}.`));
      } else {
        console.log(chalk.red(`Failed to update todo ${id} (hash mismatch?).`));
      }
    } else if (!subCommand) {
      console.log(chalk.cyan('\n=== Todos ===\n'));
      console.log(context.ctx.todo.printTodoList());
      console.log(chalk.gray('\nSubcommands:'));
      console.log(chalk.gray('  /todos add <name> [-n <note>]  Add a new todo'));
      console.log(chalk.gray('  /todos clear                   Clear all todos'));
      console.log(chalk.gray('  /todos done <id> [note]        Mark a todo as done'));
      console.log(chalk.gray('  /todos undone <id> [note]      Mark a todo as not done'));
    } else {
      console.log(chalk.yellow(`Unknown subcommand: ${subCommand}`));
      console.log(chalk.gray('Available: add, clear, done, undone'));
    }
  },
};
