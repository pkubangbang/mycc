/**
 * /help command - Show all slash commands and their descriptions
 *
 * Usage:
 *   /help    - List all commands grouped by simple vs with-args
 */

import type { SlashCommand } from '../types.js';
import { slashRegistry } from './index.js';
import chalk from 'chalk';

export const helpCommand: SlashCommand = {
  name: 'help',
  description: 'Show all slash commands and their usage',
  handler: () => {
    // Get all commands from the registry
    const commands = slashRegistry.list().map(name => slashRegistry.get(name)!);

    // Commands that take arguments (based on their descriptions/usage)
    const withArgs = ['issues', 'load', 'wiki', 'domain'];
    
    // Split into two categories
    const simpleCommands = commands.filter(c => !withArgs.includes(c.name));
    const argCommands = commands.filter(c => withArgs.includes(c.name));

    console.log(chalk.cyan('\n=== Slash Commands ===\n'));

    // Simple commands (no arguments required)
    console.log(chalk.green('Simple commands:'));
    for (const cmd of simpleCommands) {
      console.log(chalk.white(`  /${cmd.name}`) + chalk.gray(` - ${cmd.description}`));
    }

    // Commands with arguments
    console.log(chalk.green('\nCommands with arguments:'));
    for (const cmd of argCommands) {
      console.log(chalk.white(`  /${cmd.name}`) + chalk.gray(` - ${cmd.description}`));
    }

    console.log();
  },
};