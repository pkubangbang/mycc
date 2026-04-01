/**
 * core.ts - Core module: workdir and logging
 */

import chalk from 'chalk';
import type { CoreModule } from '../types.js';

/**
 * Color functions for tool prefixes
 */
const TOOL_COLORS: Record<string, (text: string) => string> = {
  // File operations
  bash: chalk.cyan, // shell commands
  read: chalk.green, // input
  write: chalk.blue, // output
  edit: chalk.magenta, // modification

  // Task management
  task_create: chalk.yellow,
  task_update: chalk.yellow,
  task_list: chalk.yellow,
  todo_write: chalk.yellow,

  // Team management
  tm_create: chalk.magentaBright,
  tm_remove: chalk.redBright,
  mail_to: chalk.cyanBright,
  broadcast: chalk.cyanBright,

  // Background tasks
  bg: chalk.gray,

  // Skills
  skill_load: chalk.cyanBright,

  // Default
  _default: chalk.white,
};

/**
 * Core module implementation
 */
export class Core implements CoreModule {
  private workDir: string;
  private questionFn: ((query: string) => Promise<string>) | null = null;

  constructor(workDir?: string) {
    this.workDir = workDir || process.cwd();
  }

  /**
   * Get current working directory
   */
  getWorkDir(): string {
    return this.workDir;
  }

  /**
   * Set current working directory
   */
  setWorkDir(dir: string): void {
    this.workDir = dir;
  }

  /**
   * Log a message to console
   * Thread-safe: console.log is atomic in Node.js
   */
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const colorFn = TOOL_COLORS[tool] || TOOL_COLORS._default;
    const prefix = `${chalk.gray(`[${timestamp}]`)} ${colorFn(`[${tool}]`)}`;

    switch (level) {
      case 'error':
        console.error(`${prefix} ${chalk.red(`ERROR: ${message}`)}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${chalk.yellow(`WARN: ${message}`)}`);
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }

  /**
   * Set the question function for interactive prompts
   * Called by main() after readline interface is created
   */
  setQuestionFn(fn: (query: string) => Promise<string>): void {
    this.questionFn = fn;
  }

  /**
   * Ask user a question and wait for response
   * Used by tools to get user input during execution
   * @param query - The question to ask
   * @param asker - Optional name of who is asking (defaults to 'lead')
   */
  async question(query: string, asker: string = 'lead'): Promise<string> {
    if (!this.questionFn) {
      throw new Error('Question function not initialized. Ensure readline is set up.');
    }
    // Log that this asker is asking (the actual question is shown by readline)
    this.brief('info', `${asker}:question`, 'waiting for user input...');
    return this.questionFn(query);
  }
}

/**
 * Create a core module instance
 */
export function createCore(workDir?: string): CoreModule {
  return new Core(workDir);
}