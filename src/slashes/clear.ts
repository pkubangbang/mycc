/**
 * /clear command - Clear conversation history, todos, issues, and sequence state
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { Triologue } from '../loop/triologue.js';
import { clearWrapUp } from '../loop/esc-wrap-up.js';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear conversation history, todos, issues, and start fresh',
  handler: (context) => {
    const triologue = context.triologue as Triologue;
    triologue.clear();
    context.sequence?.clear();
    clearWrapUp();
    context.ctx.todo.clear();
    context.ctx.issue.clearAll();
    console.log(chalk.green('Conversation, todos, and issues cleared. Starting fresh.'));
  },
};