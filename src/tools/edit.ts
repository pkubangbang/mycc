/**
 * edit.ts - Replace exact text in file
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import * as fs from 'fs';
import type { ToolDefinition, AgentContext } from '../types.js';
import { resolvePath } from '../utils/path.js';
import { checkSensitivePath } from '../utils/sensitive-paths.js';
import { stripBom, detectLineEnding, normalizeLineEndings, countReplacementChars, hasBom } from '../utils/encoding.js';

export const editTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Replace exact text in an existing file. old_text is a LITERAL string match (NOT a regex) — characters like ) $ [ . are matched verbatim. old_text must exist exactly once in the file. Use this for targeted edits instead of rewriting entire files. After writing, the file is re-read and verified; on verification failure the original content is restored and an error is returned. The strip_bom parameter (default false) controls whether a UTF-8 BOM is removed; by default the file\'s BOM state is preserved as-is.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace root.',
      },
      old_text: {
        type: 'string',
        description:
          'Exact LITERAL text to find and replace (NOT a regex — ) $ [ . * are matched verbatim). Must match exactly including whitespace and be unique in the file.',
      },
      new_text: {
        type: 'string',
        description: 'Text to replace old_text with. Can be empty string to delete the old_text.',
      },
      strip_bom: {
        type: 'boolean',
        description:
          'Whether to remove a UTF-8 BOM (EF BB BF) from the file. Default false: the BOM is preserved as-is (if the file had one, it is kept; if not, none is added). Set true to strip an existing BOM. The BOM presence is detected heuristically before the edit.',
      },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    // Explicit required-argument validation. The input_schema marks
    // path/old_text/new_text as required, but tool-call arg validation does
    // not enforce this before the handler runs (see loader.ts / collect.ts),
    // so a missing arg reaches the handler as `undefined`. Validating here
    // gives the agent a clear, actionable message instead of a downstream
    // crash such as "Cannot read properties of undefined (reading 'startsWith')".
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;
    // strip_bom: default false → preserve the file's existing BOM state.
    // true → remove a BOM if present. Only true/false are accepted; any other
    // value falls back to the default (false) so a malformed arg never
    // silently strips a BOM.
    const stripBomArg = args.strip_bom === true;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return 'Error: `path` argument is required and must be a non-empty string.';
    }
    if (typeof oldText !== 'string') {
      return 'Error: `old_text` argument is required and must be a string.';
    }
    if (typeof newText !== 'string') {
      return 'Error: `new_text` argument is required and must be a string.';
    }

    try {
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
      const rawContent = fs.readFileSync(resolvedPath, 'utf-8');

      // Heuristically detect the original BOM presence BEFORE stripping it.
      // This drives the strip_bom decision on write: by default (strip_bom
      // false) the file's BOM state is preserved as-is, so editing a BOM file
      // no longer silently drops the BOM.
      const originalHadBom = hasBom(rawContent);

      // Strip BOM for in-memory matching (the LLM's old_text/new_text never
      // include a BOM). The BOM is re-applied on write per the strip_bom flag.
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

      // Decide whether the written file should carry a BOM.
      // - strip_bom=true: never write a BOM (remove any existing one).
      // - strip_bom=false (default): preserve the file's original BOM state —
      //   re-prepend a BOM iff the file had one before the edit.
      const writeWithBom = !stripBomArg && originalHadBom;
      writeContentWithBom(resolvedPath, result, writeWithBom);

      // --- Post-write verification (defensive) ---
      // Re-read the written file and confirm the replacement actually produced
      // the expected state: old_text is gone, and new_text appears exactly once
      // (unless new_text is empty, i.e. a deletion). This catches any edge case
      // where the on-disk result diverges from the in-memory computation. On
      // failure we restore the original content so the file is not left in a
      // corrupted state, and return an error so the agent can retry (e.g. with
      // write_file to rewrite the whole file).
      const writtenRaw = fs.readFileSync(resolvedPath, 'utf-8');
      const writtenStripped = stripBom(writtenRaw);
      const writtenIsCRLF = detectLineEnding(writtenStripped) === 'crlf';
      const writtenNormalized = writtenIsCRLF ? normalizeLineEndings(writtenStripped) : writtenStripped;

      // Post-write check: old_text should be gone UNLESS new_text itself
      // contains old_text as a substring (e.g. replacing "header" with
      // "header\nmiddle" — old_text legitimately reappears). In that case the
      // "old_text still present" substring check is meaningless, so we skip
      // the rollback and rely on the new_text count check below to confirm the
      // edit took. Without this guard, any edit whose new_text re-includes
      // old_text is falsely rolled back.
      const oldTextStillExpected = normalizedNewText.includes(normalizedOldText);
      if (!oldTextStillExpected && writtenNormalized.includes(normalizedOldText)) {
        // old_text still present and NOT expected → the replacement did not
        // take. Roll back to the original bytes (BOM state preserved per
        // originalHadBom).
        writeContentWithBom(resolvedPath, content, originalHadBom);
        return `Error: Post-write verification failed in ${filePath} — old_text is still present after the edit. The original file has been restored. This indicates an internal replacement mismatch; consider using write_file to rewrite the whole file.`;
      }

      // For non-empty new_text, require it to appear exactly once. (When
      // new_text is empty the replacement is a deletion, so there is nothing
      // to count.) Note: new_text may legitimately already exist elsewhere in
      // the file (e.g. a duplicate line); in that rare case we skip the
      // "exactly once" assertion rather than rolling back a correct edit, but
      // we still report the count so the agent can review.
      if (normalizedNewText.length > 0) {
        const newCount = writtenNormalized.split(normalizedNewText).length - 1;
        if (newCount === 0) {
          // new_text not present at all → replacement silently lost. Roll back
          // to the original bytes (BOM state preserved per originalHadBom).
          writeContentWithBom(resolvedPath, content, originalHadBom);
          return `Error: Post-write verification failed in ${filePath} — new_text is not present after the edit. The original file has been restored. This indicates an internal replacement mismatch; consider using write_file to rewrite the whole file.`;
        }
        if (newCount > 1) {
          // new_text appears more than once. This can happen when new_text
          // duplicates text that already existed elsewhere. The edit itself is
          // likely still correct, so we do NOT roll back, but we surface the
          // anomaly so the agent can read_file and review.
          return `OK (warning: new_text appears ${newCount} times in the result — review with read_file to confirm the edit is as intended)`;
        }
      }

      // Byte-level self-check: report first bytes, BOM presence, and line-ending
      // style so the agent can detect encoding anomalies in the same turn.
      const written = fs.readFileSync(resolvedPath);
      const first4 = Array.from(written.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      // Report the ACTUAL written BOM state (from the raw bytes), not the
      // stripped copy, so the agent sees whether the BOM was preserved/removed.
      const bomPresent = written.length >= 3 &&
        written[0] === 0xef && written[1] === 0xbb && written[2] === 0xbf;
      const leStyle = detectLineEnding(writtenStripped);
      return `OK (first4=${first4}, bom=${bomPresent}, newline=${leStyle})`;
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  },
};

/**
 * Write text content to a file, optionally prepending a UTF-8 BOM (EF BB BF).
 *
 * Node's `fs.writeFileSync(path, str, 'utf-8')` never emits a BOM, so to
 * preserve a file's BOM we must prepend the BOM bytes explicitly via a Buffer.
 * When withBom is false, the content is written as plain UTF-8 (no BOM).
 *
 * @param filePath - Absolute path to write
 * @param text - The text content (must NOT already include a BOM character)
 * @param withBom - If true, prepend the UTF-8 BOM; if false, write plain UTF-8
 */
function writeContentWithBom(filePath: string, text: string, withBom: boolean): void {
  if (withBom) {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from(text, 'utf-8');
    fs.writeFileSync(filePath, Buffer.concat([bom, body]));
  } else {
    fs.writeFileSync(filePath, text, 'utf-8');
  }
}