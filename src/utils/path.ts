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

/**
 * Robust workspace-containment check.
 *
 * A bare `resolved.startsWith(workdir)` is unsafe: a sibling directory that
 * shares a prefix (e.g. workdir `/proj/mycc` vs `/proj/mycc-evil/escape.txt`)
 * passes the prefix test and escapes the workspace. The correct check is
 * `path.relative(workdir, resolved)`:
 *   - ''        → resolved IS the workdir (contained)
 *   - '..'/'..' → resolved is outside or an ancestor (not contained)
 *   - otherwise → resolved is inside (contained)
 * On Windows `path.relative` is case-insensitive for drive letters, so this
 * also avoids false "external" results from case differences.
 *
 * @param resolved - already-absolute path (run through resolvePath first)
 * @param workdir  - the workspace root (absolute)
 * @returns true if `resolved` is the workdir itself or inside it
 */
export function isInsideWorkspace(resolved: string, workdir: string): boolean {
  if (workdir === '') return false;
  const rel = path.relative(workdir, resolved);
  return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..'));
}
