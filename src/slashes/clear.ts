/**
 * /clear command - Clear conversation history
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { Triologue } from '../loop/triologue.js';
import { clearWrapUp } from '../loop/esc-wrap-up.js';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear conversation history and start fresh',
  handler: (context) => {
    const triologue = context.triologue as Triologue;
    triologue.clear();
    clearWrapUp();
    console.log(chalk.green('Conversation cleared. Starting fresh.'));
  },
};