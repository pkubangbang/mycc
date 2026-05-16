/**
 * core.ts - Core module: workdir and logging
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type { CoreModule } from '../../types.js';
import { ollama } from '../../ollama.js';
import { agentIO } from '../../loop/agent-io.js';
import { getVisionModel, isVisionEnabled } from '../../config.js';
import { BaseCore } from '../shared/base-core.js';
import { evaluateGrant } from '../grant/grant-evaluator.js';

/**
 * Grant scope for external path access
 */
type GrantScope = 'file' | 'folder' | 'folder_recursive';

/**
 * Core module implementation for parent process
 * Extends BaseCore for workDir and mindmap management
 */
export class Core extends BaseCore implements CoreModule {
  private modeState: 'plan' | 'normal' = 'normal';
  private allowedFile?: string;

  /**
   * Session-scoped grants for external path access.
   * Maps resolved path → granted scope.
   * One-way open: grants are never revoked during the session.
   */
  private externalGrants: Map<string, GrantScope> = new Map();

  constructor(workDir?: string) {
    super(workDir || process.cwd());
  }

  /**
   * Get current mode (implementation-only, NOT in CoreModule interface)
   */
  getMode(): 'plan' | 'normal' {
    return this.modeState;
  }

  /**
   * Get allowed file for plan mode (implementation-only, NOT in CoreModule interface)
   */
  getAllowedFile(): string | undefined {
    return this.allowedFile;
  }

  /**
   * Set mode (implementation-only, NOT in CoreModule interface)
   * @param mode - The mode to set ('plan' or 'normal')
   * @param allowedFile - Optional file path that can be edited in plan mode
   */
  setMode(mode: 'plan' | 'normal', allowedFile?: string): void {
    this.modeState = mode;
    this.allowedFile = allowedFile;
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
    agentIO.brief(level, tool, message, detail);
  }

  /**
   * Verbose-only logging
   * Only outputs when -v flag is set
   * @param tool - Tool/module name
   * @param message - Log message
   * @param data - Optional data to pretty-print as JSON
   */
  verbose(tool: string, message: string, data?: unknown): void {
    agentIO.verbose(tool, message, data);
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
    this.brief('info', 'question', '--------------------', `${asker} has a question`);
    return await agentIO.ask(query);
  }

  /**
   * Describe an image using the vision model
   * @param image - Base64-encoded image string or file path
   * @param prompt - Optional custom prompt for the vision model
   * @returns Description of the image
   */
  async imgDescribe(image: string, prompt?: string): Promise<string> {
    // Check if vision is enabled first
    if (!isVisionEnabled()) {
      throw new Error('Vision features are disabled. Set OLLAMA_VISION_MODEL to a vision model (e.g., gemma4:31b-cloud) to enable screen and read_picture tools.');
    }

    const VISION_MODEL = getVisionModel();
    const DEFAULT_PROMPT =
      'You are an image analyzer. Carefully examine this image and describe all visible content in detail. Include: text content, UI elements, objects, people, colors, layout, and any other relevant details. Be thorough and precise.';

    const customPrompt = prompt || DEFAULT_PROMPT;
    let base64Image: string;
    let imagePath: string | undefined;

    // Check if input is a file path or base64 data
    if (fs.existsSync(image)) {
      // It's a file path
      imagePath = image;
      const imageBuffer = fs.readFileSync(image);
      base64Image = imageBuffer.toString('base64');
      this.brief('info', 'img_describe', `Reading image file: ${image} (${imageBuffer.length} bytes)`);
    } else {
      // Assume it's already base64 encoded
      base64Image = image;
      this.brief('info', 'img_describe', `Processing base64 image (${base64Image.length} chars)`);
    }

    // Resize image if too large (width > 1280px) to keep payload manageable
    const { base64: resizedBase64, tempPath } = await this.resizeImageIfNeeded(base64Image, imagePath);
    base64Image = resizedBase64;

    try {
      const response = await ollama.chat({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: customPrompt,
            images: [base64Image],
          },
        ],
      });

      const description = response.message?.content || 'No description returned from vision model.';
      this.brief('info', 'img_describe', `Image description complete (${description.length} chars)`);
      return description;
    } catch (err) {
      const errMsg = (err as Error).message;
      this.brief('error', 'img_describe', `Vision model error: ${errMsg}`);

      // Provide actionable guidance based on common failure modes
      let guidance: string;
      if (errMsg.toLowerCase().includes('not found') || errMsg.toLowerCase().includes('does not exist')) {
        guidance = `The model "${VISION_MODEL}" is not available. Pull it first:\n  ollama pull ${VISION_MODEL}`;
      } else if (errMsg.toLowerCase().includes('connection') || errMsg.toLowerCase().includes('econnrefused')) {
        guidance = `Ollama server is not reachable. Make sure it's running:\n  ollama serve`;
      } else if (errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('timed out')) {
        guidance = `The vision model timed out. Try using a smaller image or a faster vision model.`;
      } else {
        guidance = `Unexpected error from vision model. Verify:\n  1. Ollama is running: ollama serve\n  2. Model is pulled: ollama pull ${VISION_MODEL}\n  3. Model supports vision/multimodal input`;
      }

      throw new Error(`Vision model failed: ${errMsg}\n\nGuidance: ${guidance}`, { cause: err });
    } finally {
      // Cleanup temp file if created
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  /**
   * Resize image if width > 1280px using sharp (cross-platform)
   * Returns the base64-encoded image and optional temp file path for cleanup
   * @throws Error if resize is needed but fails
   */
  private async resizeImageIfNeeded(base64Image: string, _originalPath?: string): Promise<{ base64: string; tempPath?: string }> {
    const maxWidth = 1280;

    try {
      // Decode base64 to buffer
      const imageBuffer = Buffer.from(base64Image, 'base64');
      const image = sharp(imageBuffer);

      // Get metadata to check dimensions
      const metadata = await image.metadata();

      if (!metadata.width || metadata.width <= maxWidth) {
        // No resize needed
        return { base64: base64Image };
      }

      // Resize needed
      this.brief('info', 'img_describe', `Resizing image from ${metadata.width}px to ${maxWidth}px wide`);

      // Resize and convert to buffer
      const resizedBuffer = await sharp(imageBuffer)
        .resize(maxWidth)
        .toBuffer();

      return { base64: resizedBuffer.toString('base64') };
    } catch (err) {
      throw new Error(`Failed to process image: ${(err as Error).message}`, { cause: err });
    }
  }

  /**
   * Request grant for sensitive operations
   * Parent is trusted but still respects mode
   * For bash: delegates to grant evaluator (5-step judging process)
   * For files: checks mode and allowed file
   * @param tool - The tool requesting grant
   * @param args - Tool arguments (path for file ops, command and intent for bash)
   * @returns Grant result with approval status and optional reason
   */
  async requestGrant(tool: 'write_file' | 'edit_file' | 'bash', args: {
    path?: string;
    command?: string;
    intent?: string;
  }): Promise<{ approved: boolean; reason?: string }> {
    // For bash: delegate to grant evaluator
    if (tool === 'bash') {
      return evaluateGrant('lead', { tool, ...args }, this);
    }

    // For files: existing logic
    if (this.modeState === 'plan') {
      // Check if the requested file matches the allowed file
      if (args.path && this.allowedFile) {
        const resolvedRequested = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(this.workDir, args.path);
        const resolvedAllowed = path.isAbsolute(this.allowedFile)
          ? this.allowedFile
          : path.resolve(this.workDir, this.allowedFile);

        if (resolvedRequested === resolvedAllowed) {
          return { approved: true };
        }
      }

      return {
        approved: false,
        reason: `Error: You are in plan mode. DO NOT make any code change${this.allowedFile ? ` except editing the file at ${this.allowedFile}` : ''}`,
      };
    }
    return { approved: true };
  }

  /**
   * Request access to a file/directory outside the workspace.
   *
   * Checks existing grants first (session-scoped, one-way open).
   * If not yet granted, asks the user via question() with options 1/2/3/4.
   *
   * @param tool - The tool requesting external access
   * @param requestedPath - The resolved absolute path
   * @returns Result with approval, resolvedPath, and optional reason
   */
  async requestExternalPathAccess(
    tool: 'read_file' | 'write_file' | 'edit_file',
    requestedPath: string,
  ): Promise<{ approved: boolean; resolvedPath: string; reason?: string }> {
    // Check if already granted
    const existingGrant = this.findExistingGrant(requestedPath);
    if (existingGrant) {
      return { approved: true, resolvedPath: requestedPath };
    }

    // Build the grant prompt
    const dirName = path.dirname(requestedPath);
    const fileName = path.basename(requestedPath);
    const prompt = `${tool} wants to access a file outside the workspace:\n` +
      `  ${requestedPath}\n\n` +
      `Choose:\n` +
      `  1) Grant access to this folder: ${dirName}/\n` +
      `  2) Grant access to this folder and all subdirectories: ${dirName}/\n` +
      `  3) Grant access to this file only: ${fileName}\n` +
      `  4) Deny`;

    const response = await this.question(prompt, 'lead');
    const choice = response.trim();

    // Parse user response
    if (choice === '1') {
      this.externalGrants.set(dirName, 'folder');
      return { approved: true, resolvedPath: requestedPath };
    } else if (choice === '2') {
      this.externalGrants.set(dirName, 'folder_recursive');
      return { approved: true, resolvedPath: requestedPath };
    } else if (choice === '3') {
      this.externalGrants.set(requestedPath, 'file');
      return { approved: true, resolvedPath: requestedPath };
    } else {
      // 4 or any other response → deny
      return { approved: false, resolvedPath: requestedPath, reason: 'Access denied by user' };
    }
  }

  /**
   * Check if a path is covered by an existing session-scoped grant.
   * @returns The matching GrantScope, or undefined if no grant covers this path
   */
  private findExistingGrant(requestedPath: string): GrantScope | undefined {
    // Check exact file grant
    if (this.externalGrants.get(requestedPath) === 'file') {
      return 'file';
    }

    // Check folder grants
    for (const [grantedPath, scope] of this.externalGrants) {
      if (scope === 'folder_recursive' && requestedPath.startsWith(grantedPath + path.sep)) {
        return 'folder_recursive';
      }
      if (scope === 'folder_recursive' && requestedPath === grantedPath) {
        return 'folder_recursive';
      }
      if (scope === 'folder' && path.dirname(requestedPath) === grantedPath) {
        return 'folder';
      }
    }

    return undefined;
  }

  /**
   * Wrap a slow operation with ESC-aware quick return
   * 
   * When ESC is pressed during a slow operation:
   * - The original promise continues in background
   * - onCleanUp is called immediately
   * - The result of onCleanUp is returned to caller
   * 
   * If ESC is not pressed, returns the original promise result.
   * 
   * @param operation - A function that receives an AbortController and returns the slow operation promise
   * @param onCleanUp - Called when ESC is pressed, must return the fallback result
   * @returns Original result if not interrupted, or onCleanUp result if ESC pressed
   */
  async escAware<T>(
    operation: (abortController: AbortController) => Promise<T>,
    onCleanUp: () => T | Promise<T>
  ): Promise<T> {
    // Check if already in neglected mode (ESC already pressed before entering escAware)
    if (agentIO.isNeglectedMode()) {
      // Use verbose logging instead of brief to avoid showing internal messages to user
      this.verbose('escAware', 'ESC already pressed - returning cleanup result');
      return onCleanUp();
    }

    // Create abort controller for this operation
    const abortController = new AbortController();

    // Create a deferred promise that can be resolved when ESC is pressed
    let escResolver: ((value: T) => void) | null = null;
    const escPromise = new Promise<T>((resolve) => {
      escResolver = resolve;
    });

    // Register callback BEFORE starting the operation
    const onNeglectedHandler = async () => {
      // Use verbose logging instead of brief to avoid showing internal messages to user
      this.verbose('escAware', 'ESC pressed during slow operation - returning cleanup result');
      abortController.abort();
      const result = await onCleanUp();
      if (escResolver) {
        escResolver(result);
      }
    };
    const unsubscribe = agentIO.onNeglected(onNeglectedHandler);

    try {
      // Start the operation AFTER callback is registered, passing the abort controller
      const operationPromise = operation(abortController);

      // Race between the operation and ESC
      // MUST use await so finally runs after the race completes, not immediately
      return await Promise.race([operationPromise, escPromise]);
    } finally {
      unsubscribe();
    }
  }
}