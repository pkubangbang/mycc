/**
 * core.ts - Core module: workdir and logging
 */

import chalk from 'chalk';
import type { CoreModule, TranscriptModule } from '../types.js';
import { ollama } from '../ollama.js';
import { WebFetchResponse, WebSearchResult } from 'ollama';

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
  private transcript: TranscriptModule | null = null;

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
   * Set the transcript module for logging
   */
  setTranscript(transcript: TranscriptModule): void {
    this.transcript = transcript;
  }

  /**
   * Log a message to console and transcript
   * Thread-safe: console.log is atomic in Node.js
   */
  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
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

    // Log to transcript
    if (this.transcript) {
      this.transcript.logBrief(level, tool, message);
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
    // Log to transcript
    if (this.transcript) {
      this.transcript.logQuestion(asker, query);
    }
    // Log that this asker is asking (the actual question is shown by readline)
    this.brief('info', `${asker}:question`, 'waiting for user input...');
    const response = await this.questionFn(query);
    // Log response to transcript
    if (this.transcript) {
      this.transcript.logAnswer(asker, response);
    }
    return response;
  }

  /**
   * Search the web for information
   * @param query - The search query
   */
  async webSearch(query: string): Promise<WebSearchResult[]> {
    this.brief('info', 'webSearch', `searching: ${query}`);
    try {
      const response = await ollama.webSearch({ query });
      const results = response.results || [];
      this.brief('info', 'webSearch', `found ${results.length} results`);
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.brief('error', 'webSearch', `failed: ${message}`);
      throw error;
    }
  }

  /**
   * Fetch and parse content from a specific URL
   * @param url - The URL to fetch
   */
  async webFetch(url: string): Promise<WebFetchResponse> {
    this.brief('info', 'webFetch', `fetching: ${url}`);
    try {
      const response = await ollama.webFetch({ url });
      this.brief('info', 'webFetch', `fetched: ${response.title}`);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.brief('error', 'webFetch', `failed: ${message}`);
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