/**
 * core.ts - Core module: workdir and logging
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import type { CoreModule, PictureResult } from '../../types.js';
import { imgDescribe } from '../../engine/chat-provider.js';
import { agentIO } from '../../loop/agent-io.js';
import { getVisionModel, isVisionEnabled, getImgCacheDir } from '../../config.js';
import { BaseCore } from '../shared/base-core.js';
import { evaluateGrant } from '../grant/grant-evaluator.js';

/**
 * Grant scope for external path access
 */
type GrantScope = 'file' | 'folder' | 'folder_recursive' | 'folder_recursive_readonly';

/**
 * A cached [focus, description] pair for an image.
 */
interface FocusPair {
  focus: string;        // original prompt string, or "general description" if none given
  description: string;  // vision model output for this focus
}

/**
 * On-disk cache entry for a described image, stored at .mycc/imgcache/<hash>.json
 */
interface PictureCacheEntry {
  statKey: string;      // `${mtimeMs}|${size}` — staleness check
  pairs: FocusPair[];   // accumulated focus+description pairs
}

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

  /**
   * Directory for the disk-based image description cache (.mycc/imgcache/).
   * Cached read_picture results live here as <hash>.json files.
   */
  private readonly pictureCacheDir: string;

  constructor(workDir?: string) {
    super(workDir || process.cwd());
    this.pictureCacheDir = getImgCacheDir();
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
  async question(query: string, asker: string, options?: { onEsc?: string; onEnter?: string }): Promise<string> {
    // Validate query
    if (!query || typeof query !== 'string') {
      throw new Error('Question query must be a non-empty string');
    }

    // Display who is asking, then the query (via agentIO.ask)
    this.brief('info', 'question', '--------------------', `${asker} has a question`);
    return await agentIO.ask(query, { onEsc: options?.onEsc, onEnter: options?.onEnter });
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

    // Resize image if too large (width > 1920px) to keep payload manageable
    const { base64: resizedBase64, tempPath } = await this.resizeImageIfNeeded(base64Image, imagePath);
    base64Image = resizedBase64;

    try {
      const description = await imgDescribe(base64Image, customPrompt);
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
   * Resize image if width > 1920px using sharp (cross-platform)
   * Returns the base64-encoded image and optional temp file path for cleanup
   * @throws Error if resize is needed but fails
   */
  private async resizeImageIfNeeded(base64Image: string, _originalPath?: string): Promise<{ base64: string; tempPath?: string }> {
    const maxWidth = 1920;

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

  // ─── Multi-Focus Image Cache (readPictureCached) ───────────────────────

  /**
   * Normalize an absolute path to a stable, cross-platform string before hashing.
   * - Replace backslashes with forward slashes (Windows-safe)
   * - Lowercase the Windows drive letter
   * - Strip a trailing slash (but keep root '/')
   */
  private normalizeForHash(p: string): string {
    let n = p.replace(/\\/g, '/');
    if (/^[A-Z]:\//.test(n)) {
      n = n[0].toLowerCase() + n.slice(1);
    }
    if (n.length > 1 && n.endsWith('/')) {
      n = n.slice(0, -1);
    }
    return n;
  }

  /**
   * Compute the cache file path for a given image absolute path.
   * 16 hex chars of SHA-256 — filesystem-safe, fixed length, project-consistent
   * (matches wiki.ts and todo.ts hash conventions).
   */
  private getCacheFilePath(absolutePath: string): string {
    const hash = createHash('sha256').update(this.normalizeForHash(absolutePath)).digest('hex').slice(0, 16);
    return path.join(this.pictureCacheDir, `${hash}.json`);
  }

  /**
   * Compute the M cache token from the normalized path + all focuses (in order).
   * The token encodes the current state of the cache entry. The LLM passes it
   * back to authorize adding a new focus; a stale token returns the current
   * state without a vision call.
   *
   * Uses JSON.stringify of the [path, ...focuses] array rather than plain
   * string concatenation: `["a","bc"]` and `["ab","c"]` would produce the same
   * joined string, causing a token collision. JSON.stringify preserves the
   * element boundaries.
   */
  private computeCacheToken(absolutePath: string, focuses: string[]): string {
    const normalizedPath = this.normalizeForHash(absolutePath);
    return createHash('sha256').update(JSON.stringify([normalizedPath, ...focuses])).digest('hex').slice(0, 16);
  }

  /**
   * Read a cache file. Returns null if the file is missing, corrupt, or
   * structurally invalid — the caller treats null as a cache miss.
   */
  private readCacheFile(filePath: string): PictureCacheEntry | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(raw) as PictureCacheEntry;
      if (!entry.statKey || !Array.isArray(entry.pairs)) return null;
      return entry;
    } catch {
      return null; // corrupt JSON → treat as cache miss
    }
  }

  /**
   * Atomically write a cache entry. Uses a PID-suffixed temp file then
   * fs.renameSync (atomic on both POSIX and NTFS) so concurrent writers from
   * different processes never observe a torn write.
   */
  private writeCacheFile(filePath: string, entry: PictureCacheEntry): void {
    // Ensure the cache directory exists (defensive — ensureDirs() also covers it)
    if (!fs.existsSync(this.pictureCacheDir)) {
      fs.mkdirSync(this.pictureCacheDir, { recursive: true });
    }
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(entry, null, 2));
    fs.renameSync(tempPath, filePath);
  }

  /**
   * Read an image with multi-focus caching. Returns accumulated [focus, description]
   * pairs and a cache token (M). Pass the token back to add a new focus.
   *
   * Flow:
   * - Cache miss (no file or stale statKey): vision call, write fresh entry, return pairs + M.
   * - Cache hit, no cache token: return cached pairs + M_current, no vision call (prompt ignored).
   * - Cache hit, valid token + new focus: vision call, add pair, return all pairs + new M.
   * - Cache hit, valid token + existing focus: no vision call, return all pairs + same M.
   * - Cache hit, stale token: no vision call, return current pairs + M_current.
   *
   * @param imagePath - Absolute path to the image file
   * @param prompt - Optional prompt (becomes the focus label; defaults to "general description")
   * @param cacheToken - Optional M token from a previous read; authorizes adding a new focus
   * @returns PictureResult with accumulated pairs and the current cache token
   */
  async readPictureCached(
    imagePath: string,
    prompt?: string,
    cacheToken?: string,
  ): Promise<PictureResult> {
    const focus = (prompt || 'general description').trim();
    const stat = fs.statSync(imagePath);
    const statKey = `${stat.mtimeMs}|${stat.size}`;
    const cacheFile = this.getCacheFilePath(imagePath);

    const entry = this.readCacheFile(cacheFile);
    const cacheHit = !!entry && entry.statKey === statKey;

    // Cache miss: vision call, write fresh entry
    if (!cacheHit) {
      this.brief('info', 'read_picture_cached', `cache miss: ${imagePath}`);
      const description = await this.imgDescribe(imagePath, prompt);
      const newEntry: PictureCacheEntry = { statKey, pairs: [{ focus, description }] };
      this.writeCacheFile(cacheFile, newEntry);
      const token = this.computeCacheToken(imagePath, [focus]);
      return { pairs: newEntry.pairs, cacheToken: token };
    }

    // Cache hit: compute the current token from existing focuses
    const currentFocuses = entry!.pairs.map(p => p.focus);
    const currentToken = this.computeCacheToken(imagePath, currentFocuses);

    // No cache token passed: return cached pairs, no vision call (prompt ignored)
    if (!cacheToken) {
      this.brief('info', 'read_picture_cached', `cache hit (no token): ${imagePath}`);
      return { pairs: entry!.pairs, cacheToken: currentToken };
    }

    // Stale token: return current state, no vision call
    if (cacheToken !== currentToken) {
      this.brief('info', 'read_picture_cached', `cache hit (stale token): ${imagePath}`);
      return { pairs: entry!.pairs, cacheToken: currentToken };
    }

    // Valid token: check if focus exists (exact string match, trimmed)
    const existing = entry!.pairs.find(p => p.focus.trim() === focus);
    if (existing) {
      this.brief('info', 'read_picture_cached', `cache hit (focus exists): ${imagePath}`);
      return { pairs: entry!.pairs, cacheToken: currentToken };
    }

    // New focus: vision call, add pair, return all pairs + new token
    this.brief('info', 'read_picture_cached', `cache merge (new focus): ${imagePath}`);
    const description = await this.imgDescribe(imagePath, prompt);
    const updatedEntry: PictureCacheEntry = { statKey, pairs: [...entry!.pairs, { focus, description }] };
    this.writeCacheFile(cacheFile, updatedEntry);
    const newToken = this.computeCacheToken(imagePath, [...currentFocuses, focus]);
    return { pairs: updatedEntry.pairs, cacheToken: newToken };
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
    const existingGrant = this.findExistingGrant(requestedPath, tool);
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

    const response = await this.question(prompt, 'lead', { onEsc: '4' });
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
   * Pre-grant external path access for a directory and all subdirectories.
   * Session-scoped — no user prompt is shown for paths under this directory.
   *
   * @param dir - Absolute directory path to auto-grant
   */
  addExternalAutoGrant(dir: string): void {
    this.externalGrants.set(dir, 'folder_recursive_readonly');
  }

  /**
   * Check if a path is covered by an existing session-scoped grant.
   * @param requestedPath - The resolved absolute path to check
   * @param tool - The tool requesting access (read-only grants reject write tools)
   * @returns The matching GrantScope, or undefined if no grant covers this path
   */
  private findExistingGrant(requestedPath: string, tool?: 'read_file' | 'write_file' | 'edit_file'): GrantScope | undefined {
    // Check exact file grant
    if (this.externalGrants.get(requestedPath) === 'file') {
      return 'file';
    }

    // Check folder grants
    for (const [grantedPath, scope] of this.externalGrants) {
      // Read-only grants only allow read_file
      if (scope === 'folder_recursive_readonly' && tool !== 'read_file') {
        continue;
      }
      if (scope === 'folder_recursive_readonly' && requestedPath.startsWith(grantedPath + path.sep)) {
        return 'folder_recursive_readonly';
      }
      if (scope === 'folder_recursive_readonly' && requestedPath === grantedPath) {
        return 'folder_recursive_readonly';
      }
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

      // Suppress unhandled rejection from the losing promise BEFORE the race.
      // When ESC wins the race, operationPromise may reject during the race
      // itself (e.g., retryChat throws StreamAbortedError on the aborted signal
      // as soon as abortController.abort() fires inside onNeglectedHandler).
      // The .catch() must be attached before Promise.race, otherwise Node.js
      // detects an UnhandledPromiseRejection between the rejection and the
      // late .catch() attachment after the await.
      operationPromise.catch(() => {});

      // Race between the operation and ESC
      // MUST use await so finally runs after the race completes, not immediately
      return await Promise.race([operationPromise, escPromise]);
    } finally {
      unsubscribe();
    }
  }
}