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

  // Team communication
  spawn_teammate: chalk.magentaBright,
  send_message: chalk.cyanBright,
  broadcast: chalk.cyanBright,

  // Background tasks
  bg: chalk.gray,

  // Default
  _default: chalk.white,
};

/**
 * Core module implementation
 */
export class Core implements CoreModule {
  private workDir: string;

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
}

/**
 * Create a core module instance
 */
export function createCore(workDir?: string): CoreModule {
  return new Core(workDir);
}