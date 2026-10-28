/**
 * core.ts - ChildCore implementation for IPC-based core operations
 */

import type { CoreModule, PictureResult, AskResult } from '../../types.js';
import type { AutoCommitEntry } from '../../loop/auto-state.js';
import type { CrossroadCardWire } from '../../loop/crossroad-card.js';
import { ipc, sendStatus } from './ipc-helpers.js';
import { isVerbose } from '../../config.js';
import { BaseCore } from '../shared/base-core.js';

/**
 * Core module for child process
 * Extends BaseCore for workDir and mindmap management
 * All other operations go through IPC to parent
 */
export class ChildCore extends BaseCore implements CoreModule {
  private name: string;

  constructor(name: string, workDir: string) {
    super(workDir);
    this.name = name;
  }

  getName(): string {
    return this.name;
  }

  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string, opts?: { synthetic?: boolean; crossroad?: CrossroadCardWire }): void {
    if (level === 'error') {
      ipc.sendNotification('error', { error: message, detail, tool, synthetic: opts?.synthetic ?? false });
    } else {
      // The child's brief level rides along as `level` (row lead: teammate
      // warn → info de-escalation). The old wire collapsed info and warn into
      // one 'log' type, so the parent could only re-brief 'info' and a warn
      // surfaced as info in the lead transcript. `type: 'log'` is kept for
      // wire compatibility; `level` is the authoritative severity.
      // Forward `tool` so the parent can build the @-prefix teammate label
      // (@sender/tool) for the WebUI teammate timeline. Without this, the
      // tool tag is lost at the IPC boundary and all teammate messages end
      // up labeled only with the sender name in the main chat log. See the
      // "@-prefix teammate label convention" section in MYCC.md.
      // `synthetic` rides along so machine-originated briefs emitted inside
      // the child (hook engine, debug evaluator) stay hidden in the WebUI
      // after the parent re-briefs them under the @label.
      ipc.sendNotification('log', { message, detail, tool, level, synthetic: opts?.synthetic ?? false });
    }
  }

  /**
   * Verbose-only logging - sends to parent via IPC
   * Only outputs when -v flag is set
   */
  verbose(tool: string, message: string, data?: unknown): void {
    if (!isVerbose()) return;
    ipc.sendNotification('verbose', { tool, message, data });
  }

  async question(query: string, asker: string, options?: { onEsc?: string; onEnter?: string }): Promise<AskResult> {
    // Transition to holding while waiting for answer
    sendStatus('holding');

    try {
      // Use no timeout for user questions - user can take arbitrary time to respond
      // The parent's Core.question() builds the full AskResult (including the
      // auto-mode short-circuit with source:'auto'), so the IPC response carries
      // the whole object — return it verbatim rather than re-deriving it here.
      const response = await ipc.sendRequest<AskResult>('question', {
        query,
        asker,
        options,
      }, 0);
      return response;
    } finally {
      // Transition back to working after getting answer
      sendStatus('working');
    }
  }

  /**
   * Describe an image using the vision model
   * Uses IPC to call parent's core.imgDescribe()
   * @param image - Base64-encoded image string or file path
   * @param prompt - Optional custom prompt for the vision model
   * @param signal - Optional AbortSignal for ESC handling. Forwarded to the
   *   parent over IPC as an aborted flag; the parent's handler consumes it by
   *   creating a pre-aborted signal so the engine's retryChat rejects
   *   immediately via StreamAbortedError rather than issuing a vision call
   *   that would be thrown away.
   * @returns Description of the image
   */
  async imgDescribe(image: string, prompt?: string, signal?: AbortSignal): Promise<string> {
    const response = await ipc.sendRequest<{ description: string }>('core_img_describe', {
      image,
      prompt,
      aborted: signal?.aborted ?? false,
    });
    return response.description;
  }

  /**
   * Read an image with multi-focus caching. Delegates to the parent's Core
   * via IPC — only the parent process touches the disk cache files.
   * @param imagePath - Absolute path to the image file
   * @param prompt - Optional prompt (becomes the focus label)
   * @param cacheToken - Optional M token from a previous read
   * @returns PictureResult with accumulated pairs and the current cache token
   */
  async readPictureCached(imagePath: string, prompt?: string, cacheToken?: string, signal?: AbortSignal): Promise<PictureResult> {
    const response = await ipc.sendRequest<PictureResult>('core_read_picture_cached', {
      imagePath,
      prompt,
      cacheToken,
      aborted: signal?.aborted ?? false,
    });
    return response;
  }

  /**
   * Request grant for sensitive operations
   * Always sends IPC to parent - parent knows the mode
   * @param tool - The tool requesting grant
   * @param args - Tool arguments (path for file ops, command and intent for bash)
   * @returns Grant result with approval status and optional reason
   */
  async requestGrant(tool: 'write_file' | 'edit_file' | 'bash', args: {
    path?: string;
    command?: string;
    intent?: string;
  }): Promise<{ approved: boolean; reason?: string }> {
    // NO TIMEOUT. The parent's grant path can block on a human [y/N] prompt
    // (dangerous/batch confirmations) or on a slow LLM safeguard — both are
    // unbounded by design. A 5 s timeout here used to turn a still-pending
    // verdict into "denied" in the child, after which the user's "y" was
    // discarded against a deleted pendingRequests slot. Waiting is correct:
    // the parent always answers, and a dead parent is caught by IPC disconnect.
    const response = await ipc.sendRequest<{ approved: boolean; reason?: string }>(
      'grant_request',
      { tool, ...args },
      0
    );
    return response;
  }

  /**
   * Request access to a file/directory outside the workspace.
   * Child process always sends IPC to parent for evaluation.
   * @param tool - The tool requesting external access
   * @param requestedPath - The resolved absolute path
   * @returns Result with approval, resolvedPath, and optional reason
   */
  async requestExternalPathAccess(
    tool: 'read_file' | 'write_file' | 'edit_file' | 'grep',
    requestedPath: string,
  ): Promise<{ approved: boolean; resolvedPath: string; reason?: string }> {
    const response = await ipc.sendRequest<{ approved: boolean; resolvedPath: string; reason?: string }>(
      'external_path_access',
      { tool, requestedPath },
      0, // No timeout - user interaction may take arbitrary time
    );
    return response;
  }

  /**
   * Pre-grant external path access for a directory (no-op in child process).
   * Child processes send external path requests to parent via IPC;
   * the parent's Core handles the actual grant check.
   *
   * @param _dir - Absolute directory path (unused in child)
   * @param _writable - When true, grant read+write (no-op in child; handled
   *   by the parent's grant check, so parent-side read+write grants cover
   *   teammates too).
   */
  addExternalAutoGrant(_dir: string, _writable = false): void {
    // No-op: grants are managed by the parent process
  }

  /**
   * Get current agent mode (plan or normal)
   * Child processes (teammates) are always in normal mode - they execute tasks, not plan
   * Plan mode is only for the lead agent
   * @returns 'normal' always for child processes
   */
  getMode(): 'plan' | 'normal' {
    return 'normal';
  }

  /**
   * Teammates never use autonomous mode — it is a lead-only loop behavior
   * (replaces the PROMPT stage with AWAIT and auto-replies question()).
   * Always returns false for child processes.
   */
  getAuto(): boolean {
    return false;
  }

  /** No-op: auto mode is lead-only. Kept for CoreModule interface conformance. */
  setAuto(_value: boolean): void {
    // No-op: auto mode is managed by the parent process
  }

  /**
   * Teammates never hold an auto-commit grant — the authorization belongs to
   * the lead, and a teammate in its own worktree can never inherit it. The
   * empty list makes the `git_commit` gate fall through to the normal prompt
   * (or the mail-to-lead path) for every teammate.
   */
  getAutoCommitBranches(): string[] {
    return [];
  }

  /** No-op: the auto-commit allow-list is lead-only. */
  addAutoCommitBranches(_branches: readonly string[], _autoAdd: boolean): AutoCommitEntry[] {
    return [];
  }

  /** No-op: the auto-commit allow-list is lead-only. */
  removeAutoCommitBranches(_branches: readonly string[]): string[] {
    return [];
  }

  /** No-op: the auto-commit allow-list is lead-only. */
  clearAutoCommitBranches(): string[] {
    return [];
  }

  /** Always empty for a child process (see getAutoCommitBranches). */
  effectiveAutoCommitBranches(_autoMode: boolean): string[] {
    return [];
  }

  /**
   * Wrap a slow operation with ESC-aware quick return
   * 
   * In child processes, ESC handling is not yet implemented.
   * This simply executes the operation with a dummy abort controller.
   * TODO: Implement IPC-based ESC handling for child processes.
   * 
   * @param operation - A function that receives an AbortController and returns the slow operation promise
   * @param _onCleanUp - Cleanup function (unused in child process, kept for API consistency)
   * @returns Result of the operation
   */
  async escAware<T>(
    operation: (abortController: AbortController) => Promise<T>,
    _onCleanUp: () => T | Promise<T>
  ): Promise<T> {
    // Child processes don't receive ESC directly - they rely on parent IPC
    // For now, just execute the operation with a dummy abort controller
    const abortController = new AbortController();
    return operation(abortController);
  }
}