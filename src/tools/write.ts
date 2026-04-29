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
  description: 'Create or completely replace a file. Parent directories are created automatically. Use edit_file for targeted changes to existing files instead of rewriting entire files.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace root. Parent directories are created automatically if needed.',
      },
      content: {
        type: 'string',
        description: 'Complete content to write to the file. This will replace any existing content entirely.',
      },
    },
    required: ['path', 'content'],
  },
  scope: ['main', 'child', 'bg'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    // Check permission (respects plan mode)
    const grant = await ctx.core.requestGrant('write_file', args);
    if (!grant.approved) {
      return grant.reason || 'Operation not permitted in current mode';
    }

    const filePath = args.path as string;
    const content = args.content as string;

    ctx.core.brief('info', 'write', `${filePath} (${content.length} bytes)`);

    try {
      const safe = safePath(filePath, ctx.core.getWorkDir());
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content, 'utf-8');
      return 'OK';
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};