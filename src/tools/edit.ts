/**
 * edit.ts - Replace exact text in file
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import * as fs from 'fs';
import type { ToolDefinition, AgentContext } from '../types.js';
import { resolvePath } from '../utils/path.js';
import { checkSensitivePath } from '../utils/sensitive-paths.js';

export const editTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Replace exact text in an existing file. The old_text must exist exactly once in the file. Use this for targeted edits instead of rewriting entire files.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace root.',
      },
      old_text: {
        type: 'string',
        description: 'Exact text to find and replace. Must match exactly including whitespace and be unique in the file.',
      },
      new_text: {
        type: 'string',
        description: 'Text to replace old_text with. Can be empty string to delete the old_text.',
      },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;

    // Resolve path first (tilde expansion, relative → absolute)
    const resolvedPath = resolvePath(filePath, ctx.core.getWorkDir());
    args.path = resolvedPath;  // Update args for requestGrant

    // Check permission (respects plan mode, worktree ownership)
    const grant = await ctx.core.requestGrant('edit_file', args);
    if (!grant.approved) {
      return grant.reason || 'Operation not permitted in current mode';
    }

    // Check if path is outside workspace
    const isExternal = !resolvedPath.startsWith(ctx.core.getWorkDir());
    if (isExternal) {
      // Block sensitive system paths (never writable, regardless of grant)
      const sensitive = checkSensitivePath(resolvedPath);
      if (sensitive) {
        return `Error: Cannot edit ${resolvedPath} — ${sensitive.reason}. This path is protected from automated modification.`;
      }

      // Request user grant for external path
      const access = await ctx.core.requestExternalPathAccess('edit_file', resolvedPath);
      if (!access.approved) {
        return `Error: ${access.reason || 'Access denied'}`;
      }
    }

    ctx.core.brief('info', 'edit', filePath);

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');

      if (!content.includes(oldText)) {
        return `Error: Text not found in ${filePath}`;
      }

      // Count occurrences
      const occurrences = content.split(oldText).length - 1;
      if (occurrences > 1) {
        return `Error: Found ${occurrences} occurrences of old_text. Please provide more context to make it unique.`;
      }

      fs.writeFileSync(resolvedPath, content.replace(oldText, newText), 'utf-8');
      return 'OK';
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};