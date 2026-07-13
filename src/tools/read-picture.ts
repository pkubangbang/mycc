/**
 * read-picture.ts - Read and describe image files using vision model
 *
 * Multi-focus caching: each read returns accumulated [focus, description] pairs
 * and a cache token (M). Pass M back with a new prompt to add a focus without
 * re-reading the image from scratch. Without M, a cache hit returns the cached
 * pairs only (no vision call).
 *
 * The cache lives on disk at .mycc/imgcache/ and is owned by the parent's Core
 * (children delegate via IPC). Image resizing is handled by imgDescribe.
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';

/**
 * Validate path doesn't escape workspace
 */
function safePath(p: string, workdir: string): string {
  const resolved = path.resolve(workdir, p);
  if (!resolved.startsWith(workdir)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/**
 * Format the tool result string from the accumulated focus pairs and cache token.
 */
function formatResult(
  imagePath: string,
  pairs: Array<{ focus: string; description: string }>,
  cacheToken: string,
): string {
  const pairsBlock = pairs
    .map(p => `[${p.focus}]: ${p.description}`)
    .join('\n\n');
  const hint = `To ask a question about this image, call read_picture again with cache="${cacheToken}" and your new prompt. The new focus will be merged into the cache.`;
  return `## Image: ${imagePath}\n\n${pairsBlock}\n\n---\n💡 Cache token: ${cacheToken}\n${hint}`;
}

export const readPictureTool: ToolDefinition = {
  name: 'read_picture',
  description: 'Read and describe an image file using the vision model. Returns accumulated [focus, description] pairs and a cache token (M). Reading the same image again without the token returns cached pairs without re-invoking the vision model. Pass the token back with a new prompt to add a new focus to the cache.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the image file. Supports common image formats (PNG, JPG, GIF, etc.). Use forward slashes (e.g., "screenshots/image.png").',
      },
      prompt: {
        type: 'string',
        description: 'Optional custom prompt for the vision model. Use this to ask specific questions about the image (e.g., "What text is visible?" or "Describe the UI elements"). The prompt becomes the focus label in the cache.',
      },
      cache: {
        type: 'string',
        description: 'Cache token (M) returned by a previous read_picture call on the same image. Pass it back with a new prompt to add a new focus to the cached image without re-reading it from scratch. If omitted on a cached image, cached pairs are returned with no vision call.',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const imagePath = args.path as string;
    const prompt = args.prompt as string | undefined;
    const cacheToken = args.cache as string | undefined;

    ctx.core.brief('info', 'read_picture', imagePath);

    try {
      // Validate path
      const safe = safePath(imagePath, ctx.core.getWorkDir());

      // Check file exists
      if (!fs.existsSync(safe)) {
        return `Error: Image file not found: ${imagePath}`;
      }

      // Check it's likely an image file
      const ext = path.extname(safe).toLowerCase();
      const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      if (!validExtensions.includes(ext)) {
        return `Warning: File extension "${ext}" may not be a supported image format. Supported formats: ${validExtensions.join(', ')}`;
      }

      // Delegate to core.readPictureCached (handles caching, vision call, M token)
      const result = await ctx.core.readPictureCached(safe, prompt, cacheToken);

      return formatResult(imagePath, result.pairs, result.cacheToken);
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'read_picture', err.message);
      return `Error: ${err.message}`;
    }
  },
};