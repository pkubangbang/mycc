/**
 * core.ts - ChildCore implementation for IPC-based core operations
 */

import type { CoreModule, PictureResult } from '../../types.js';
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

  brief(level: 'info' | 'warn' | 'error', tool: string, message: string, detail?: string): void {
    if (level === 'error') {
      ipc.sendNotification('error', { error: message, detail, tool });
    } else {
      // Forward `tool` so the parent can build the @-prefix teammate label
      // (@sender/tool) for the WebUI teammate timeline. Without this, the
      // tool tag is lost at the IPC boundary and all teammate messages end
      // up labeled only with the sender name in the main chat log. See the
      // "@-prefix teammate label convention" section in MYCC.md.
      ipc.sendNotification('log', { message, detail, tool });
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

  async question(query: string, asker: string, options?: { onEsc?: string; onEnter?: string }): Promise<string> {
    // Transition to holding while waiting for answer
    sendStatus('holding');

    try {
      // Use no timeout for user questions - user can take arbitrary time to respond
      const response = await ipc.sendRequest<{ response: string }>('question', {
        query,
        asker,
        options,
      }, 0);
      return response.response;
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
   * @returns Description of the image
   */
  async imgDescribe(image: string, prompt?: string): Promise<string> {
    const response = await ipc.sendRequest<{ description: string }>('core_img_describe', {
      image,
      prompt,
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
  async readPictureCached(imagePath: string, prompt?: string, cacheToken?: string): Promise<PictureResult> {
    const response = await ipc.sendRequest<PictureResult>('core_read_picture_cached', {
      imagePath,
      prompt,
      cacheToken,
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
    // Always ask parent via IPC - parent knows the mode
    const response = await ipc.sendRequest<{ approved: boolean; reason?: string }>(
      'grant_request',
      { tool, ...args },
      5000
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
    tool: 'read_file' | 'write_file' | 'edit_file',
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
   */
  addExternalAutoGrant(_dir: string): void {
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