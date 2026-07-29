/**
 * write.ts - Write content to file
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * Line-ending policy:
 *   - `newline: 'auto'` (default) → follow platform convention:
 *       CRLF on Windows (process.platform === 'win32'), LF elsewhere.
 *     This prevents LF-only .ps1 scripts from breaking PowerShell 5.1's
 *     parser (block comments <# #> followed by braces mis-parse on LF).
 *   - `newline: 'lf'`   → force LF (Unix).
 *   - `newline: 'crlf'` → force CRLF (Windows).
 *
 * BOM policy: UTF-8 is written WITHOUT a BOM by default. A BOM is harmful
 * for most tools (jar/MANIFEST, javac, git diff, shell scripts). The LLM may
 * still request a BOM via the optional `bom` parameter for the rare formats
 * that require it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, AgentContext } from '../types.js';
import { resolvePath } from '../utils/path.js';
import { checkSensitivePath } from '../utils/sensitive-paths.js';
import { stripBom, applyLineEndings, detectLineEnding, hasBom } from '../utils/encoding.js';

export const writeTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Create or completely replace a file. Parent directories are created automatically. Use edit_file for targeted changes to existing files instead of rewriting entire files. Line endings default to the platform convention (CRLF on Windows, LF elsewhere); override with `newline`. UTF-8 is written without a BOM unless `bom: true` is set.',
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
      newline: {
        type: 'string',
        enum: ['auto', 'lf', 'crlf'],
        description:
          "Line-ending style. 'auto' (default) follows the platform convention: CRLF on Windows, LF elsewhere. 'lf' forces Unix LF, 'crlf' forces Windows CRLF. Use 'crlf' for .ps1 scripts run by PowerShell 5.1, 'lf' for shell scripts and cross-platform source.",
      },
      bom: {
        type: 'boolean',
        description:
          'If true, prepend a UTF-8 BOM. Default false — a BOM breaks jar/MANIFEST, javac, git, and shells, so only enable it for formats that require one.',
      },
    },
    required: ['path', 'content'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const filePath = args.path as string;
    const content = args.content as string;
    const newline = (args.newline as 'auto' | 'lf' | 'crlf' | undefined) ?? 'auto';
    const wantBom = (args.bom as boolean | undefined) ?? false;

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

    // Resolve the target line-ending style. 'auto' follows the platform
    // convention so that, e.g., .ps1 scripts generated on Windows use CRLF
    // and parse correctly under PowerShell 5.1.
    const style: 'lf' | 'crlf' =
      newline === 'auto' ? (process.platform === 'win32' ? 'crlf' : 'lf') : newline;

    // Strip any BOM the LLM may have copied from a previously-read file, then
    // (optionally) re-add one only when the caller explicitly requested it.
    const withoutBom = stripBom(content);
    const withBom = wantBom ? `\uFEFF${withoutBom}` : withoutBom;
    // Apply the target line-ending style to the whole content.
    const finalContent = applyLineEndings(withBom, style);

    ctx.core.brief('info', 'write', `${filePath} (${finalContent.length} bytes, ${style})`);

    try {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, finalContent, 'utf-8');

      // Byte-level self-check: report the first bytes, BOM presence, and the
      // dominant line-ending style so the agent can detect encoding anomalies
      // in the same turn without a separate bash read-back.
      const written = fs.readFileSync(resolvedPath);
      const first4 = Array.from(written.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      const bomPresent = hasBom(finalContent);
      const leStyle = detectLineEnding(finalContent);
      return `OK (first4=${first4}, bom=${bomPresent}, newline=${leStyle})`;
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};