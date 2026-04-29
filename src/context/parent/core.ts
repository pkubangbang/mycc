/**
 * core.ts - Core module: workdir and logging
 */

import chalk from 'chalk';
import * as fs from 'fs';
import sharp from 'sharp';
import type { CoreModule } from '../../types.js';
import { ollama, retryWithBackoff } from '../../ollama.js';
import { WebFetchResponse, WebSearchResult } from 'ollama';
import { agentIO } from '../../loop/agent-io.js';
import { isVerbose, getVisionModel, isVisionEnabled } from '../../config.js';

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
  order: chalk.blueBright,

  // Background tasks
  bg: chalk.gray,
  bg_create: chalk.gray,
  bg_print: chalk.gray,
  bg_remove: chalk.red,
  bg_await: chalk.blue,

  // Skills
  skill_load: chalk.cyanBright,

  // Screen reading
  screen: chalk.greenBright,

  // Default
  _default: chalk.white,
};

/**
 * Core module implementation
 */
export class Core implements CoreModule {
  private workDir: string;
  private modeState: 'plan' | 'normal' = 'normal';

  constructor(workDir?: string) {
    this.workDir = workDir || process.cwd();
  }

  /**
   * Get current mode (implementation-only, NOT in CoreModule interface)
   */
  getMode(): 'plan' | 'normal' {
    return this.modeState;
  }

  /**
   * Set mode (implementation-only, NOT in CoreModule interface)
   */
  setMode(mode: 'plan' | 'normal'): void {
    this.modeState = mode;
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
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const colorFn = TOOL_COLORS[tool] || TOOL_COLORS._default;
    const prefix = `${chalk.gray(`[${timestamp}]`)} ${colorFn(`[${tool}]`)}`;

    // Build output with optional detail (greyed text after tool name)
    const detailPart = detail ? ` ${chalk.gray(detail)}` : '';
    const header = `${prefix}${detailPart}`;

    // Use agentIO instead of console (buffers during interaction)
    switch (level) {
      case 'error':
        agentIO.error(`${header}\n${chalk.red(message)}`);
        break;
      case 'warn':
        agentIO.warn(`${header}\n${chalk.yellow(message)}`);
        break;
      default:
        agentIO.log(`${header}\n${message}`);
    }
  }

  /**
   * Verbose-only logging
   * Only outputs when -v flag is set
   * @param tool - Tool/module name
   * @param message - Log message
   * @param data - Optional data to pretty-print as JSON
   */
  verbose(tool: string, message: string, data?: unknown): void {
    if (!isVerbose()) return;

    const timestamp = new Date().toISOString();
    const prefix = chalk.gray(`[${timestamp}]`) + chalk.magenta(`[verbose][${tool}]`);

    // Use agentIO instead of console (buffers during interaction)
    if (data !== undefined) {
      agentIO.log(`${prefix} ${message}`);
      agentIO.log(chalk.gray(JSON.stringify(data, null, 2)));
    } else {
      agentIO.log(`${prefix} ${message}`);
    }
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
    this.brief('info', 'question', `${asker} asks:`);
    return await agentIO.ask(query);
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
   * @param _tool - The tool requesting grant (unused in parent, for interface consistency)
   * @param _args - Tool arguments (unused in parent, for interface consistency)
   * @returns Grant result with approval status and optional reason
   */
  async requestGrant(_tool: 'write_file' | 'edit_file' | 'bash', _args: {
    path?: string;
    command?: string;
  }): Promise<{ approved: boolean; reason?: string }> {
    // Parent is trusted but still respects mode
    if (this.modeState === 'plan') {
      return {
        approved: false,
        reason: 'Error: Code changes are prohibited in plan mode.',
      };
    }
    return { approved: true };
  }
}