/**
 * path.ts - Shared path resolution utilities
 *
 * Provides consistent path handling for read/write/edit tools:
 * - Expands ~ to user's home directory
 * - Resolves relative paths against workdir
 * - Handles absolute paths
 */

import * as path from 'path';
import * as os from 'os';

/**
 * Resolve a path that may include ~, relative paths, or absolute paths.
 * 
 * 1. Expands ~ to the user's home directory
 * 2. Resolves relative paths against workdir
 * 3. Returns the canonical absolute path
 *
 * @param p - The raw path from tool arguments (may include ~)
 * @param workdir - The current working directory
 * @returns The resolved absolute path
 */
export function resolvePath(p: string, workdir: string): string {
  // Guard against missing/non-string path argument. Tool callers (the LLM)
  // may omit `path` or pass a non-string value; without this guard we throw
  // "Cannot read properties of undefined (reading 'startsWith')" from the
  // .startsWith call below, which escapes to the tool dispatcher as an
  // opaque "Error executing <tool>: ..." and is hard to diagnose.
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(
      'path argument is required and must be a non-empty string. Provide a valid file path.'
    );
  }

  // Expand ~ to home directory
  if (p.startsWith('~')) {
    const home = os.homedir();
    p = path.join(home, p.slice(1));
  }

  // Resolve relative to workdir (no-op if already absolute)
  return path.resolve(workdir, p);
}
