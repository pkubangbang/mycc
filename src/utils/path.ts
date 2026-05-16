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
  // Expand ~ to home directory
  if (p.startsWith('~')) {
    const home = os.homedir();
    p = path.join(home, p.slice(1));
  }

  // Resolve relative to workdir (no-op if already absolute)
  return path.resolve(workdir, p);
}
