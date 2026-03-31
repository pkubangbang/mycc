/**
 * read.ts - Read file contents
 *
 * Scope: ['main', 'child'] - Available to main and child agents
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

export const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read file contents from the workspace.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read (optional)',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const filePath = args.path as string;
    const limit = args.limit as number | undefined;

    ctx.core.brief('info', 'read', filePath);

    try {
      const safe = safePath(filePath, ctx.core.getWorkDir());
      const content = fs.readFileSync(safe, 'utf-8');
      const lines = content.split('\n');

      if (limit && limit < lines.length) {
        return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
      }

      return content.slice(0, 50000);
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};