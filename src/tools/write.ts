/**
 * write.ts - Write content to file
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';
import { resolvePath } from '../utils/path.js';
import { checkSensitivePath } from '../utils/sensitive-paths.js';

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
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const filePath = args.path as string;
    const content = args.content as string;

    // Resolve path first (tilde expansion, relative → absolute)
    const resolvedPath = resolvePath(filePath, ctx.core.getWorkDir());
    args.path = resolvedPath;  // Update args for requestGrant

    // Check permission (respects plan mode, worktree ownership)
    const grant = await ctx.core.requestGrant('write_file', args);
    if (!grant.approved) {
      return grant.reason || 'Operation not permitted in current mode';
    }

    // Check if path is outside workspace
    const isExternal = !resolvedPath.startsWith(ctx.core.getWorkDir());
    if (isExternal) {
      // Block sensitive system paths (never writable, regardless of grant)
      const sensitive = checkSensitivePath(resolvedPath);
      if (sensitive) {
        return `Error: Cannot write to ${resolvedPath} — ${sensitive.reason}. This path is protected from automated modification.`;
      }

      // Request user grant for external path
      const access = await ctx.core.requestExternalPathAccess('write_file', resolvedPath);
      if (!access.approved) {
        return `Error: ${access.reason || 'Access denied'}`;
      }
    }

    ctx.core.brief('info', 'write', `${filePath} (${content.length} bytes)`);

    try {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, content, 'utf-8');
      return 'OK';
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};