/**
 * base-core.ts - Base class for Core modules
 *
 * Holds common state: workDir and mindmap
 * Provides common methods that don't require IPC
 */

import type { Mindmap } from '../../mindmap/types.js';
import { ollama, retryWithBackoff } from '../../ollama.js';
import { WebFetchResponse, WebSearchResult } from 'ollama';

/**
 * BaseCore - Common base for Core modules
 *
 * Contains shared state and methods:
 * - workDir management
 * - mindmap data
 * - web operations (webSearch, webFetch)
 * - confusion index tracking
 */
export abstract class BaseCore {
  protected workDir: string;
  protected mindmap: Mindmap | null = null;
  protected confusionIndex: number = 0;

  constructor(workDir: string) {
    this.workDir = workDir;
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
   * Get the loaded mindmap data
   */
  getMindmap(): Mindmap | null {
    return this.mindmap;
  }

  /**
   * Set the mindmap data
   */
  setMindmap(mindmap: Mindmap | null): void {
    this.mindmap = mindmap;
  }

  /**
   * Get current confusion index (0-20 range)
   */
  getConfusionIndex(): number {
    return this.confusionIndex;
  }

  /**
   * Increase confusion index by delta (can be negative to decrease)
   * Value is clamped to minimum 0
   */
  increaseConfusionIndex(delta: number): void {
    this.confusionIndex = Math.max(0, this.confusionIndex + delta);
  }

  /**
   * Reset confusion index to 0
   */
  resetConfusionIndex(): void {
    this.confusionIndex = 0;
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
        throw new Error(`Unauthorized: Set OLLAMA_API_KEY in .env for web search access. Original error: ${message}`, { cause: error });
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
        throw new Error(`Unauthorized: Set OLLAMA_API_KEY in .env for web fetch access. Original error: ${message}`, { cause: error });
      }
      throw error;
    }
  }
}