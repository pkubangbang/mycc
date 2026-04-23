/**
 * read-picture.ts - Read and describe image files using vision model
 *
 * Image resizing is handled by imgDescribe.
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

export const readPictureTool: ToolDefinition = {
  name: 'read_picture',
  description: 'Read and describe an image file using the vision model. Returns a detailed description of the image content including text, objects, colors, layout, and other relevant details.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the image file. Supports common image formats (PNG, JPG, GIF, etc.). Use forward slashes (e.g., "screenshots/image.png").',
      },
      prompt: {
        type: 'string',
        description: 'Optional custom prompt for the vision model. Use this to ask specific questions about the image (e.g., "What text is visible?" or "Describe the UI elements").',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const imagePath = args.path as string;
    const prompt = args.prompt as string | undefined;

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

      // Use core.imgDescribe to process the image (handles resizing)
      const description = await ctx.core.imgDescribe(safe, prompt);

      return `## Image: ${imagePath}\n\n${description}`;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'read_picture', err.message);
      return `Error: ${err.message}`;
    }
  },
};