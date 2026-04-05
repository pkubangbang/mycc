/**
 * core.ts - Core module: workdir and logging
 */

import chalk from 'chalk';
import type { CoreModule } from '../types.js';
import { ollama } from '../ollama.js';
import { WebFetchResponse, WebSearchResult } from 'ollama';
import { agentIO } from '../loop/agent-io.js';

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
  tm_await: chalk.blueBright,
  mail_to: chalk.cyanBright,
  broadcast: chalk.cyanBright,

  // Background tasks
  bg: chalk.gray,
  bg_create: chalk.gray,
  bg_print: chalk.gray,
  bg_remove: chalk.red,
  bg_await: chalk.blue,

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
   * Get agent name (main process is always 'lead')
   */
  getName(): string {
    return 'lead';
  }

  /**
   * Log a message to console
   * Thread-safe: console.log is atomic in Node.js
   */
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const colorFn = TOOL_COLORS[tool] || TOOL_COLORS._default;
    const prefix = `${chalk.gray(`[${timestamp}]`)} ${colorFn(`[${tool}]`)}`;

    // Log to console
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
   * In main process: used to handle questions from child teammates
   * In child process: routes to main via IPC (questionFn is set by child-context)
   * @param query - The question to ask
   * @param asker - Name of who is asking (required)
   */
  async question(query: string, asker: string): Promise<string> {
    // Validate query
    if (!query || typeof query !== 'string') {
      throw new Error('Question query must be a non-empty string');
    }

    // Check if shutting down
    if (agentIO.isShuttingDown()) {
      throw new Error('Agent is shutting down');
    }

    // Must have questionFn set
    if (!this.questionFn) {
      throw new Error('Question function not initialized');
    }

    this.brief('info', `question`, `${asker} has a question:`);
    return await this.questionFn(query);
  }

  /**
   * Search the web for information
   * @param query - The search query
   */
  async webSearch(query: string): Promise<WebSearchResult[]> {
    try {
      const response = await ollama.webSearch({ query });
      return response.results || [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
        throw new Error(`Unauthorized: Set OLLAMA_API_KEY in .env for web search access. Original error: ${message}`);
      }
      throw error;
    }
  }

  /**
   * Fetch and parse content from a specific URL
   * @param url - The URL to fetch
   */
  async webFetch(url: string): Promise<WebFetchResponse> {
    try {
      return await ollama.webFetch({ url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
        throw new Error(`Unauthorized: Set OLLAMA_API_KEY in .env for web fetch access. Original error: ${message}`);
      }
      throw error;
    }
  }
}

/**
 * Create a core module instance
 */
export function createCore(workDir?: string): CoreModule {
  return new Core(workDir);
}