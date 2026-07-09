/**
 * read.ts - Read file contents with file type detection
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * Features:
 * - Detects file type (text vs binary)
 * - For files with extremely long lines (e.g., minified JS): shows head+tail preview
 *   of each long line rather than truncating at a random byte offset
 * - Hard-coded limit of 1000 lines (~1/8 of context window)
 * - Shows read progress (chars/lines read vs total)
 * - Suggests follow-up tools for large files
 */

import * as fs from 'fs';
import * as path from 'path';
import { filetypeinfo } from '../utils/magic-bytes.js';
import type { ToolDefinition, AgentContext } from '../types.js';
import { getTokenThreshold, isVerbose } from '../config.js';
import { resolvePath } from '../utils/path.js';
import { stripBom, countReplacementChars } from '../utils/encoding.js';

/** Hard-coded line limit to prevent context overflow */
const LINE_LIMIT = 1000;

/**
 * Get character limit based on token threshold (half of it, ~1/8 of context)
 * This ensures the read content doesn't overwhelm the context window.
 */
function getCharLimit(): number {
  return Math.floor(getTokenThreshold() / 2);
}

/**
 * Detect if file is text or binary using magic bytes and extension
 */
function detectFileType(filePath: string, buffer: Buffer): { isText: boolean; mime?: string; extension?: string } {
  // Check magic bytes for known binary formats
  const magicInfo = filetypeinfo(buffer.slice(0, 300));

  if (magicInfo.length > 0) {
    const info = magicInfo[0];
    // Known binary types
    const binaryMimes = [
      'application/pdf', 'application/zip', 'application/x-tar',
      'application/x-gzip', 'application/x-rar',
      'image/', 'video/', 'audio/',
      'application/vnd.', 'application/octet-stream'
    ];

    const isBinary = binaryMimes.some(m => info.mime?.startsWith(m));
    if (isBinary) {
      return { isText: false, mime: info.mime, extension: info.extension };
    }
  }

  // Check extension for common binary formats
  const ext = path.extname(filePath).toLowerCase();
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
    '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
    '.exe', '.dll', '.so', '.dylib',
    '.sqlite', '.db'
  ];

  if (binaryExtensions.includes(ext)) {
    return { isText: false, extension: ext };
  }

  // Check for null bytes (common indicator of binary content)
  const hasNullBytes = buffer.slice(0, 8000).includes(0x00);
  if (hasNullBytes) {
    return { isText: false };
  }

  // Default to text
  return { isText: true, mime: 'text/plain', extension: ext };
}

export const readTool: ToolDefinition = {
  name: 'read_file',
  description: `Read file contents from the workspace or external paths. Paths use forward slashes and can be relative to workspace root, absolute, or use ~ for home directory.

Limits: reads first 1000 lines or half the token threshold (~1/8 of context window), whichever is smaller. Shows progress info (chars read / total chars, lines read / total lines) to help you decide next steps.

Reading files outside the workspace requires user grant (session-scoped).

Useful follow-ups for large files:
- Use 'bash' with 'sed -n "start,end p"' to read specific line ranges
- Use 'bash' with 'tail -n N' to read last N lines
- Use 'bash' with 'grep -n "pattern"' to find lines matching a pattern
- Use 'read_read' tool to summarize content with focus topic`,
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace root. Use forward slashes (e.g., "src/tools/bash.ts").',
      },
    },
    required: ['path'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const filePath = args.path as string;

    try {
      const resolved = resolvePath(filePath, ctx.core.getWorkDir());

      // If path is outside workspace, request grant
      const isExternal = !resolved.startsWith(ctx.core.getWorkDir());
      if (isExternal) {
        const access = await ctx.core.requestExternalPathAccess('read_file', resolved);
        if (!access.approved) {
          return `Error: ${access.reason || 'Access denied'}`;
        }
      }

      // Check if file exists
      if (!fs.existsSync(resolved)) {
        ctx.core.brief('error', 'read', `File not found: ${filePath}`);
        return `Error: File not found: ${filePath}`;
      }

      // Get file stats
      const stats = fs.statSync(resolved);

      // Read file as buffer first for type detection
      const buffer = fs.readFileSync(resolved);

      // Detect file type
      const typeInfo = detectFileType(resolved, buffer);
      ctx.core.brief('info', 'read', `${filePath} (${typeInfo.isText ? 'text' : 'binary'})`);

      // Handle binary files
      if (!typeInfo.isText) {
        const sizeKB = (stats.size / 1024).toFixed(1);
        const typeDesc = typeInfo.mime || typeInfo.extension || 'binary';
        return `Binary file detected: ${typeDesc}
Size: ${sizeKB} KB

This file cannot be displayed as text.
${typeInfo.extension === '.png' || typeInfo.extension === '.jpg' || typeInfo.extension === '.jpeg' || typeInfo.extension === '.gif'
  ? 'Use read_picture tool to analyze this image.'
  : 'Use bash tool with appropriate program to process this file.'}`;
      }

      // Handle text files
      // Strip BOM if present (e.g., from Windows Notepad-saved files)
      const content = stripBom(buffer.toString('utf-8'));
      const totalChars = content.length;
      const lines = content.split('\n');
      const totalLines = lines.length;

      // Detect encoding corruption: U+FFFD replacement characters indicate
      // the file was decoded as UTF-8 but originally encoded in a different
      // codepage (e.g. GBK/ANSI). Warn the LLM so it uses ASCII-only anchors
      // for edit_file, since old_text matching fails on corrupted lines.
      const replacementCount = countReplacementChars(content);
      const encodingWarning = replacementCount > 0
        ? `\n⚠ Encoding: ${replacementCount} replacement character${replacementCount > 1 ? 's' : ''} (U+FFFD) detected — this file has encoding corruption.\n  edit_file old_text matching may fail on lines containing these characters.\n  Use ASCII-only anchors for edits, or verify exact bytes with: [System.IO.File]::ReadAllBytes(...)`
        : '';

      // Detect minified / single-long-line files (e.g., minified JS).
      // A single enormous line passes LINE_LIMIT trivially, then gets brutally
      // truncated at charLimit, yielding useless fragments.
      // Show a head/tail preview of each long line so the LLM gets usable context.
      const MAX_LINE_LENGTH = 5000;
      const PREVIEW_CHARS = 2000; // chars to show from start + end of each long line
      let hasLongLines = false;
      for (const line of lines) {
        if (line.length > MAX_LINE_LENGTH) { hasLongLines = true; break; }
      }
      if (hasLongLines) {
        // Build a preview: for each long line, show first + last N chars
        const previewParts: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.length > MAX_LINE_LENGTH) {
            const head = line.slice(0, PREVIEW_CHARS);
            const tail = line.slice(-PREVIEW_CHARS);
            previewParts.push(
              `--- Line ${i + 1} (${line.length.toLocaleString()} chars, showing first + last ${PREVIEW_CHARS}) ---\n` +
              `${head}\n... [${(line.length - PREVIEW_CHARS * 2).toLocaleString()} chars omitted] ...\n${tail}`
            );
          } else {
            previewParts.push(line);
          }
        }

        const header = `File: ${filePath}
Chars: ${totalChars.toLocaleString()} | Lines: ${totalLines}${encodingWarning}
${'─'.repeat(60)}`;

        const suggestions = `
${'─'.repeat(60)}
⚠ This file has extremely long lines (likely minified). Shown: first + last ${PREVIEW_CHARS.toLocaleString()} chars of each long line.
To read the full content, try:
  bash: npx prettier --write ${filePath}          # De-minify JS/TS/JSON/CSS
  bash: fold -w 120 ${filePath} | head -500       # Word-wrap to 120-char lines
  bash: head -c 8000 ${filePath}                  # Raw first 8K chars`;

        return `${header}\n${previewParts.join('\n')}${suggestions}`;
      }

      // Apply hard-coded limit
      if (totalLines > LINE_LIMIT) {
        const limitedLines = lines.slice(0, LINE_LIMIT);
        const readChars = limitedLines.join('\n').length;
        const remainingLines = totalLines - LINE_LIMIT;

        // Build progress header
        const header = `File: ${filePath}
Read: ${readChars.toLocaleString()} / ${totalChars.toLocaleString()} chars (${((readChars / totalChars) * 100).toFixed(1)}%)
Lines: ${LINE_LIMIT} / ${totalLines} (${remainingLines} more lines below)${encodingWarning}
${'─'.repeat(60)}`;

        // Build suggestions
        const suggestions = `
${'─'.repeat(60)}
${remainingLines} more lines not shown. Options to continue:
  • sed -n "${LINE_LIMIT + 1},${LINE_LIMIT + 100} p" ${filePath}  # Read next 100 lines
  • sed -n "2000,3000 p" ${filePath}              # Read specific range
  • tail -n 100 ${filePath}                      # Read last 100 lines
  • grep -n "pattern" ${filePath}                # Find pattern with line numbers
  • read_read (if file in .mycc/longtext/)       # Summarize with focus`;

        return `${header}\n${limitedLines.join('\n')}${suggestions}`;
      }

      // File fits within limit
      const charLimit = getCharLimit();
      if (totalChars > charLimit) {
        // Truncate by chars as safety net
        const truncated = content.slice(0, charLimit);
        const header = `File: ${filePath}
Read: ${charLimit.toLocaleString()} / ${totalChars.toLocaleString()} chars (${((charLimit / totalChars) * 100).toFixed(1)}%)
Lines: ${totalLines} total${encodingWarning}
${'─'.repeat(60)}`;

        return `${header}\n${truncated}\n... (${(totalChars - charLimit).toLocaleString()} more chars)`;
      }

      // Show full file with stats
      const header = `File: ${filePath}
Chars: ${totalChars.toLocaleString()} | Lines: ${totalLines}${encodingWarning}
${'─'.repeat(60)}`;

      // Verbose logging: show first 50 lines in verbose mode
      if (isVerbose()) {
        const previewLines = lines.slice(0, 50);
        ctx.core.verbose('read', `First 50 lines of ${filePath}:\n${previewLines.join('\n')}`);
      }

      return `${header}\n${content}`;

    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'read', err.message);
      return `Error: ${err.message}`;
    }
  },
};