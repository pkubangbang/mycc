/**
 * edit.ts - Replace exact text in file
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import * as fs from 'fs';
import type { ToolDefinition, AgentContext } from '../types.js';
import { resolvePath } from '../utils/path.js';
import { checkSensitivePath } from '../utils/sensitive-paths.js';
import { stripBom, detectLineEnding, normalizeLineEndings, countReplacementChars } from '../utils/encoding.js';

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
      const rawContent = fs.readFileSync(resolvedPath, 'utf-8');

      // Strip BOM if present (Windows tools like Notepad often prepend it)
      const content = stripBom(rawContent);

      // Detect original line ending style (CRLF on Windows, LF on Unix)
      const isCRLF = detectLineEnding(content) === 'crlf';

      // Normalize file content and search/replace strings to LF-only
      // This is critical for CRLF/LF compatibility: the LLM always sends
      // LF-only strings in JSON tool-call arguments, but the file on disk
      // may use CRLF. Normalizing both to LF before matching ensures the
      // edit always succeeds regardless of line ending mismatch.
      const normalizedContent = isCRLF ? normalizeLineEndings(content) : content;
      const normalizedOldText = normalizeLineEndings(oldText);
      const normalizedNewText = normalizeLineEndings(newText);

      if (!normalizedContent.includes(normalizedOldText)) {
        // Check for encoding corruption (U+FFFD) that may explain the mismatch:
        // the LLM may have misread a replacement char and constructed old_text
        // with a guessed character that differs from the actual bytes on disk.
        const replacementCount = countReplacementChars(normalizedContent);
        if (replacementCount > 0) {
          return `Error: Text not found in ${filePath}. This file contains ${replacementCount} replacement character${replacementCount > 1 ? 's' : ''} (U+FFFD) from encoding corruption — your old_text may differ from the actual bytes on lines with these characters. Use grep to find exact text, or use ASCII-only anchors that avoid corrupted lines.`;
        }
        return `Error: Text not found in ${filePath}. Check for invisible characters, trailing whitespace, or line ending differences. Use grep to find the exact text: grep -n "your text" ${filePath}`;
      }

      // Count occurrences on normalized content
      const occurrences = normalizedContent.split(normalizedOldText).length - 1;
      if (occurrences > 1) {
        return `Error: Found ${occurrences} occurrences of old_text. Please provide more context to make it unique.`;
      }

      let result = normalizedContent.replace(normalizedOldText, normalizedNewText);

      // Restore original line ending style so the file's convention is preserved
      if (isCRLF) {
        result = result.replace(/\n/g, '\r\n');
      }

      fs.writeFileSync(resolvedPath, result, 'utf-8');
      return 'OK';
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};