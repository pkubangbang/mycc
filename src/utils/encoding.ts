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
