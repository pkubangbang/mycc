/**
 * core.ts - ChildCore implementation for IPC-based core operations
 */

import { WebFetchResponse, WebSearchResult } from 'ollama';
import { ollama } from '../../ollama.js';
import type { CoreModule, TranscriptModule } from '../../types.js';
import { ipc } from './ipc-helpers.js';

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
    // Use no timeout for user questions - user can take arbitrary time to respond
    const response = await ipc.sendRequest<{ response: string }>('question', {
      query,
      asker,
    }, 0);
    return response.response;
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

  setQuestionFn(): void {
    // No-op in child - questions go via IPC
  }

  setTranscript(_transcript: TranscriptModule): void {
    // No-op in child - transcript is handled by parent process
  }
}

/**
 * Create a child core module
 */
export function createChildCore(name: string, workDir: string): CoreModule {
  return new ChildCore(name, workDir);
}