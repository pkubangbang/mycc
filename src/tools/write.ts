/**
 * write.ts - Write content to file
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
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

export const writeTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file in the workspace.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['path', 'content'],
  },
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const filePath = args.path as string;
    const content = args.content as string;

    ctx.core.brief('info', 'write', `${filePath} (${content.length} bytes)`);

    try {
      const safe = safePath(filePath, ctx.core.getWorkDir());
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content, 'utf-8');
      return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};