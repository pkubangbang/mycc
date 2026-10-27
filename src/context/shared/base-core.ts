/**
 * base-core.ts - Base class for Core modules
 *
 * Holds common state: workDir and mindmap
 * Provides common methods that don't require IPC
 */

import type { Mindmap } from '../../mindmap/types.js';
import { webSearch as engineWebSearch, webFetch as engineWebFetch } from '../../engine/chat-provider.js';
import { isPlainOutput as configIsPlainOutput, getAllowAutoCommitArg } from '../../config.js';
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

  /**
   * LIVE auto-commit allow-list (branches whose `git_commit` may skip the
   * interactive confirmation in auto mode).
   *
   * Sits next to `workDir` on purpose: it is runtime, SESSION-scoped state owned
   * by the agent context — not configuration. config.ts only PARSES the
   * launch flag (`getAllowAutoCommitArg()`) and this list is seeded from it once
   * at construction; from then on only `/auto-commit` mutates it
   * (`on`/`off`/`off --all`).
   *
   * Exact string match, no globs — see the getter docs. Nothing is persisted:
   * a restart re-seeds from the launch flag.
   *
   * `/reload` does NOT inherit runtime edits: the slash respawns the lead with
   * the ORIGINAL launch argv (see slashes/reload.ts), so the new process
   * re-seeds this list from `--allow-auto-commit` alone. A branch added with
   * `/auto-commit on` — or cleared with `off --all` — is gone after a reload;
   * the launch flag is the floor. Only `/auto-commit` changes the list, and
   * only for the lifetime of THIS process.
   */
  protected allowAutoCommitBranches: string[];

  constructor(workDir: string) {
    this.workDir = workDir;
    // Seed ONCE from the launch flag. config.ts is parse-only; this array is the
    // single mutable copy every reader (git_commit, /auto-commit) consults.
    this.allowAutoCommitBranches = getAllowAutoCommitArg();
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
   * Snapshot of the auto-commit allow-list.
   *
   * A COPY: callers (e.g. the `git_commit` tool) must not be able to mutate the
   * grant by keeping the returned array. Empty array = feature OFF.
   *
   * MATCHING IS EXACT STRING EQUALITY — NO GLOBS. `release/*` does NOT match
   * the branch `release/1.2`; only a literal `release/1.2` entry does. Fail
   * direction is safe (a non-matching entry falls through to the normal deny
   * path), so listing a glob is a footgun, not a security hole.
   */
  getAllowAutoCommitBranches(): string[] {
    return [...this.allowAutoCommitBranches];
  }

  /**
   * Add one branch to the live allow-list (`/auto-commit on <branch>`).
   * Idempotent: a branch already listed is a no-op.
   *
   * @returns true when the branch was newly added; false when already present
   *          or when the argument was blank.
   */
  addAllowAutoCommitBranch(branch: string): boolean {
    const name = branch.trim();
    if (name.length === 0) return false;
    if (this.allowAutoCommitBranches.includes(name)) return false;
    this.allowAutoCommitBranches.push(name);
    return true;
  }

  /**
   * Remove one branch from the live allow-list (`/auto-commit off <branch>`).
   *
   * @returns true when the branch was listed and is now removed.
   */
  removeAllowAutoCommitBranch(branch: string): boolean {
    const name = branch.trim();
    const idx = this.allowAutoCommitBranches.indexOf(name);
    if (idx === -1) return false;
    this.allowAutoCommitBranches.splice(idx, 1);
    return true;
  }

  /**
   * Clear the live allow-list entirely (`/auto-commit off --all`).
   *
   * @returns the branches that were cleared (empty when nothing was listed).
   */
  clearAllowAutoCommitBranches(): string[] {
    const cleared = [...this.allowAutoCommitBranches];
    this.allowAutoCommitBranches.length = 0;
    return cleared;
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

  /**
   * Search the web for information
   * @param query - The search query
   */
  async webSearch(query: string): Promise<WebSearchResult[]> {
    try {
      return await engineWebSearch(query);
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
      return await engineWebFetch(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('unauthorized') || message.includes('Unauthorized')) {
        throw new Error(`Unauthorized: Set OLLAMA_API_KEY in .env for web fetch access. Original error: ${message}`, { cause: error });
      }
      throw error;
    }
  }
}