/**
 * encoding.ts - UTF-8 BOM handling and line ending utilities
 *
 * Used by read/write/edit tools to ensure consistent UTF-8 handling
 * and cross-platform line ending compatibility.
 */

/**
 * Strip a UTF-8 BOM (byte order mark) from the start of a string, if present.
 * The UTF-8 BOM is the byte sequence EF BB BF, which decodes to U+FEFF.
 * Many Windows tools (Notepad, PowerShell) prepend BOM to UTF-8 files.
 */
export function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) {
    return s.slice(1);
  }
  return s;
}

/**
 * Detect the dominant line ending style in a string.
 * Returns 'crlf' if any CRLF pair is found, otherwise 'lf'.
 */
export function detectLineEnding(s: string): 'crlf' | 'lf' {
  return /\r\n/.test(s) ? 'crlf' : 'lf';
}

/**
 * Normalize all line endings to LF (\\n) only.
 * Converts CRLF (\\r\\n) and standalone CR (\\r) to LF.
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Apply a target line-ending style to a string, converting all existing
 * line endings (CRLF, standalone CR, LF, or mixed) to the requested style.
 *
 * - 'lf'   → all line endings become \\n
 * - 'crlf' → all line endings become \\r\\n
 *
 * The conversion first normalizes everything to LF, then expands to CRLF if
 * requested. This avoids double-converting CRLF (\\r\\n → \\r\\r\\n) and
 * handles mixed-ending inputs cleanly.
 */
export function applyLineEndings(s: string, style: 'lf' | 'crlf'): string {
  const lf = normalizeLineEndings(s);
  return style === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * Detect whether a string starts with a UTF-8 BOM (U+FEFF).
 * Used by write/edit tools to report BOM presence in their self-check output.
 */
export function hasBom(s: string): boolean {
  return s.length > 0 && s.charCodeAt(0) === 0xfeff;
}

/**
 * Count U+FFFD (REPLACEMENT CHARACTER) occurrences in a string.
 *
 * U+FFFD appears when bytes are decoded as UTF-8 but were originally encoded
 * in a different codepage (e.g. GBK/ANSI on Windows). It signals **irreversible
 * encoding corruption**: the original bytes cannot be recovered from U+FFFD.
 *
 * Used by read_file to warn the LLM that edit_file old_text matching may fail
 * on lines containing these characters, and by edit_file to give a targeted
 * error message when old_text is not found in a corrupted file.
 */
export function countReplacementChars(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0xfffd) count++;
  }
  return count;
}
