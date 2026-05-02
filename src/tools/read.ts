/**
 * read.ts - Read file contents with file type detection
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 *
 * Features:
 * - Detects file type (text vs binary)
 * - Hard-coded limit of 1000 lines (~1/8 of context window)
 * - Shows read progress (chars/lines read vs total)
 * - Suggests follow-up tools for large files
 */

import * as fs from 'fs';
import * as path from 'path';
import { filetypeinfo } from '../utils/magic-bytes.js';
import type { ToolDefinition, AgentContext } from '../types.js';
import { getTokenThreshold } from '../config.js';

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
  description: `Read file contents from the workspace. Paths use forward slashes and must be relative to workspace root.

Limits: reads first 1000 lines or half the token threshold (~1/8 of context window), whichever is smaller. Shows progress info (chars read / total chars, lines read / total lines) to help you decide next steps.

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
  scope: ['main', 'child', 'bg'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const filePath = args.path as string;

    try {
      const safe = safePath(filePath, ctx.core.getWorkDir());

      // Check if file exists
      if (!fs.existsSync(safe)) {
        ctx.core.brief('error', 'read', `File not found: ${filePath}`);
        return `Error: File not found: ${filePath}`;
      }

      // Get file stats
      const stats = fs.statSync(safe);

      // Read file as buffer first for type detection
      const buffer = fs.readFileSync(safe);

      // Detect file type
      const typeInfo = detectFileType(safe, buffer);
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
      const content = buffer.toString('utf-8');
      const totalChars = content.length;
      const lines = content.split('\n');
      const totalLines = lines.length;

      // Apply hard-coded limit
      if (totalLines > LINE_LIMIT) {
        const limitedLines = lines.slice(0, LINE_LIMIT);
        const readChars = limitedLines.join('\n').length;
        const remainingLines = totalLines - LINE_LIMIT;

        // Build progress header
        const header = `File: ${filePath}
Read: ${readChars.toLocaleString()} / ${totalChars.toLocaleString()} chars (${((readChars / totalChars) * 100).toFixed(1)}%)
Lines: ${LINE_LIMIT} / ${totalLines} (${remainingLines} more lines below)
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
Lines: ${totalLines} total
${'─'.repeat(60)}`;

        return `${header}\n${truncated}\n... (${(totalChars - charLimit).toLocaleString()} more chars)`;
      }

      // Show full file with stats
      const header = `File: ${filePath}
Chars: ${totalChars.toLocaleString()} | Lines: ${totalLines}
${'─'.repeat(60)}`;

      return `${header}\n${content}`;

    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'read', err.message);
      return `Error: ${err.message}`;
    }
  },
};