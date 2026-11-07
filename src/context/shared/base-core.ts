/**
 * base-core.ts - Base class for Core modules
 *
 * Holds common state: workDir and mindmap
 * Provides common methods that don't require IPC
 */

import type { Mindmap } from '../../mindmap/types.js';
import { webSearch as engineWebSearch, webFetch as engineWebFetch } from '../../engine/chat-provider.js';
import { getApiProvider, getOllamaHost, isPlainOutput as configIsPlainOutput } from '../../config.js';
import { isDirectOllamaCloud } from '../../engine/ollama-web.js';
import type { WebFetchResponse, WebSearchResult } from '../../engine/provider-types.js';

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
   * Whether stdout decoration (spinner, progress bars, colour, title escapes)
   * must be suppressed because the output is plain — i.e. it is being piped or
   * redirected, or the user forced the plain path with `--debug-ansi`.
   *
   * This is the SINGLE verdict every decoration writer should consult rather
   * than deriving a TTY check of its own: the verdict is computed in the
   * Coordinator (the only process that owns the real terminal) and delivered
   * through the environment as `MYCC_PLAIN`; `isPlainOutput()` in config.ts is
   * the one predicate that reads it.
   *
   * Process-local and uniform: unlike the IPC-backed members, this needs no
   * round-trip — the env var is inherited by both the parent and every child
   * (teammate) process, so both observe the same answer.
   */
  isPlainOutput(): boolean {
    return configIsPlainOutput();
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

  private webAuthError(message: string, cause: unknown): Error {
    if (getApiProvider() !== 'ollama') return cause instanceof Error ? cause : new Error(message);
    const guidance = isDirectOllamaCloud(getOllamaHost())
      ? 'Set OLLAMA_API_KEY for direct Ollama Cloud web access'
      : `Authenticate or configure the web backend on Ollama at ${getOllamaHost()} (for local cloud proxying, use 'ollama signin'); mycc does not forward OLLAMA_API_KEY to this host`;
    const signinUrl = (cause as { signinUrl?: unknown })?.signinUrl;
    const signin = typeof signinUrl === 'string' ? ` Sign in at ${signinUrl}.` : '';
    return new Error(`${guidance}.${signin} Original error: ${message}`, { cause });
  }

  /**
   * Is this failure an authentication refusal?
   *
   * Prefer the transport's own classification (`OllamaHttpError.kind`, which
   * covers 401/403 AND the `{ error }`-over-HTTP-200 shape Ollama uses) over
   * sniffing the message for "401"/"unauthorized". The text fallback remains
   * only for errors raised before the HTTP layer (e.g. a bare TypeError).
   */
  private isAuthFailure(error: unknown): boolean {
    const kind = (error as { kind?: unknown })?.kind;
    if (kind === 'auth') return true;
    if (kind !== undefined) return false;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized');
  }

  /**
   * Search the web for information
   * @param query - The search query
   */
  async webSearch(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    try {
      return await engineWebSearch(query, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.isAuthFailure(error)) {
        throw this.webAuthError(error instanceof Error ? error.message : String(error), error);
      }
      throw error;
    }
  }

  /**
   * Fetch and parse content from a specific URL
   * @param url - The URL to fetch
   */
  async webFetch(url: string, signal?: AbortSignal): Promise<WebFetchResponse> {
    try {
      return await engineWebFetch(url, signal);
    } catch (error) {
      // A cancelled request is not an auth problem: never dress an abort up as
      // "check your API key", which is exactly what a text match on "aborted"
      // would have been able to do.
      if (signal?.aborted) throw error;
      if (this.isAuthFailure(error)) {
        throw this.webAuthError(error instanceof Error ? error.message : String(error), error);
      }
      throw error;
    }
  }
}