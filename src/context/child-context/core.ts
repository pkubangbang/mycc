/**
 * core.ts - ChildCore implementation for IPC-based core operations
 */

import { WebFetchResponse, WebSearchResult } from 'ollama';
import { ollama } from '../../ollama.js';
import type { CoreModule } from '../../types.js';
import { ipc, sendStatus } from './ipc-helpers.js';

/**
 * Core module for child process
 * All operations go through IPC to parent
 */
export class ChildCore implements CoreModule {
  private workDir: string;
  private name: string;

  constructor(name: string, workDir: string) {
    this.name = name;
    this.workDir = workDir;
  }

  getWorkDir(): string {
    return this.workDir;
  }

  setWorkDir(dir: string): void {
    this.workDir = dir;
  }

  getName(): string {
    return this.name;
  }

  brief(level: 'info' | 'warn' | 'error', tool: string, message: string): void {
    const formatted = `[${tool}] ${message}`;
    if (level === 'error') {
      ipc.sendNotification('error', { error: formatted });
    } else {
      ipc.sendNotification('log', { message: formatted });
    }
  }

  async question(query: string, asker: string): Promise<string> {
    // Transition to holding while waiting for answer
    sendStatus('holding');

    try {
      // Use no timeout for user questions - user can take arbitrary time to respond
      const response = await ipc.sendRequest<{ response: string }>('question', {
        query,
        asker,
      }, 0);
      return response.response;
    } finally {
      // Transition back to working after getting answer
      sendStatus('working');
    }
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
      throw error;
    }
  }

  setQuestionFn(): void {
    // No-op in child - questions go via IPC
  }
}

/**
 * Create a child core module
 */
export function createChildCore(name: string, workDir: string): CoreModule {
  return new ChildCore(name, workDir);
}