/**
 * edit.ts - Replace exact text in file
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
  scope: ['main', 'child', 'bg'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    // Check permission (respects plan mode)
    const grant = await ctx.core.requestGrant('edit_file', args);
    if (!grant.approved) {
      return grant.reason || 'Operation not permitted in current mode';
    }

    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;

    ctx.core.brief('info', 'edit', filePath);

    try {
      const safe = safePath(filePath, ctx.core.getWorkDir());
      const content = fs.readFileSync(safe, 'utf-8');

      if (!content.includes(oldText)) {
        return `Error: Text not found in ${filePath}`;
      }

      // Count occurrences
      const occurrences = content.split(oldText).length - 1;
      if (occurrences > 1) {
        return `Error: Found ${occurrences} occurrences of old_text. Please provide more context to make it unique.`;
      }

      fs.writeFileSync(safe, content.replace(oldText, newText), 'utf-8');
      return 'OK';
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};