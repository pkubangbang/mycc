/**
 * core.ts - Core module: workdir and logging
 */

import chalk from 'chalk';
import type { CoreModule } from '../types.js';
import { ollama, retryWithBackoff } from '../ollama.js';
import { WebFetchResponse, WebSearchResult } from 'ollama';
import { agentIO } from '../loop/agent-io.js';
import { isVerbose } from '../config.js';

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
  order: chalk.blueBright,

  // Background tasks
  bg: chalk.gray,
  bg_create: chalk.gray,
  bg_print: chalk.gray,
  bg_remove: chalk.red,
  bg_await: chalk.blue,

  // Skills
  skill_load: chalk.cyanBright,

  // Screen reading
  screen: chalk.greenBright,

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
   * Get agent name (main process is always 'lead')
   */
  getName(): string {
    return 'lead';
  }

  /**
   * Log a message to console
   * Thread-safe: console.log is atomic in Node.js
   * @param detail - Optional greyed text to show after tool name (for showing intent)
   */
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string): void {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const colorFn = TOOL_COLORS[tool] || TOOL_COLORS._default;
    const prefix = `${chalk.gray(`[${timestamp}]`)} ${colorFn(`[${tool}]`)}`;

    // Build output with optional detail (greyed text after tool name)
    const detailPart = detail ? ` ${chalk.gray(detail)}` : '';
    const header = `${prefix}${detailPart}`;

    // Log to console
    switch (level) {
      case 'error':
        console.error(`${header}\n${chalk.red(message)}`);
        break;
      case 'warn':
        console.warn(`${header}\n${chalk.yellow(message)}`);
        break;
      default:
        console.log(`${header}\n${message}`);
    }
  }

  /**
   * Verbose-only logging
   * Only outputs when -v flag is set
   * @param tool - Tool/module name
   * @param message - Log message
   * @param data - Optional data to pretty-print as JSON
   */
  verbose(tool: string, message: string, data?: unknown): void {
    if (!isVerbose()) return;

    const timestamp = new Date().toISOString();
    const prefix = chalk.gray(`[${timestamp}]`) + chalk.magenta(`[verbose][${tool}]`);

    if (data !== undefined) {
      console.log(`${prefix} ${message}`);
      console.log(chalk.gray(JSON.stringify(data, null, 2)));
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  /**
   * Ask user a question and wait for response
   * In main process: uses agentIO.ask() directly
   * In child process: routes to main via IPC (overridden in ChildCore)
   * @param query - The question to ask
   * @param asker - Name of who is asking (required)
   */
  async question(query: string, asker: string): Promise<string> {
    // Validate query
    if (!query || typeof query !== 'string') {
      throw new Error('Question query must be a non-empty string');
    }

    // Display who is asking, then the query (via agentIO.ask)
    this.brief('info', 'question', `${asker} asks:`);
    return await agentIO.ask(query);
  }

  /**
   * Search the web for information
   * @param query - The search query
   */
  async webSearch(query: string): Promise<WebSearchResult[]> {
    try {
      return await retryWithBackoff(async () => {
        const response = await ollama.webSearch({ query });
        return response.results || [];
      }, { maxRetries: 2 });
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
      return await retryWithBackoff(async () => {
        return await ollama.webFetch({ url });
      }, { maxRetries: 2 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
        throw new Error(`Unauthorized: Set OLLAMA_API_KEY in .env for web fetch access. Original error: ${message}`);
      }
      throw error;
    }
  }
}