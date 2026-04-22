/**
 * Slash command registry
 *
 * Manages registration and dispatch of slash commands.
 */

import type { SlashCommand, SlashCommandContext } from '../types.js';
import chalk from 'chalk';

/**
 * Registry for slash commands
 */
class SlashCommandRegistryImpl {
  private commands: Map<string, SlashCommand> = new Map();
  private aliasToCommand: Map<string, string> = new Map(); // alias -> primary name

  /**
   * Register a slash command
   */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    // Register aliases
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliasToCommand.set(alias, command.name);
      }
    }
  }

  /**
   * Get a slash command by name (or alias)
   */
  get(name: string): SlashCommand | undefined {
    // First check if it's a primary name
    const command = this.commands.get(name);
    if (command) return command;
    // Then check if it's an alias
    const primaryName = this.aliasToCommand.get(name);
    if (primaryName) {
      return this.commands.get(primaryName);
    }
    return undefined;
  }

  /**
   * List all registered command names (primary names only)
   */
  list(): string[] {
    return Array.from(this.commands.keys());
  }

  /**
   * Execute a slash command
   * @param name - Command name (without slash)
   * @param context - Command context
   * @returns true if command was found and executed, false otherwise
   */
  async execute(name: string, context: SlashCommandContext): Promise<boolean> {
    const command = this.get(name);
    if (!command) {
      console.log(chalk.yellow(`Unknown command: /${name}`));
      console.log(chalk.gray(`Available commands: ${this.list().map((c) => `/${c}`).join(', ')}`));
      return false;
    }

    try {
      await command.handler(context);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error executing /${name}:`), message);
      if (err instanceof Error && err.stack && process.env['VERBOSE']) {
        console.error(chalk.gray(err.stack));
      }
      return false;
    }
  }
}

export const slashRegistry = new SlashCommandRegistryImpl();

// Import and register all built-in commands
import { teamCommand } from './team.js';
import { todosCommand } from './todos.js';
import { skillsCommand } from './skills.js';
import { issuesCommand } from './issues.js';
import { saveCommand } from './save.js';
import { loadCommand } from './load.js';
import { clearCommand } from './clear.js';
import { wikiCommand } from './wiki.js';
import { compactCommand } from './compact.js';
import { domainCommand } from './domain.js';
import { helpCommand } from './help.js';

slashRegistry.register(teamCommand);
slashRegistry.register(todosCommand);
slashRegistry.register(skillsCommand);
slashRegistry.register(issuesCommand);
slashRegistry.register(saveCommand);
slashRegistry.register(loadCommand);
slashRegistry.register(clearCommand);
slashRegistry.register(wikiCommand);
slashRegistry.register(compactCommand);
slashRegistry.register(domainCommand);
slashRegistry.register(helpCommand);