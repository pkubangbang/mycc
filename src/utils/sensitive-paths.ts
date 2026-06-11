/**
 * sensitive-paths.ts - Sensitive path detection
 *
 * Used by write_file and edit_file to block access to system
 * and security-critical paths, even if a grant is obtained.
 */

import * as path from 'path';
import * as os from 'os';

/**
 * Normalize a Unix-style path prefix for the current platform.
 * On Windows, path.resolve('/etc') => 'C:\\etc', on Unix it stays '/etc'.
 * This ensures patterns match the normalized input path format.
 */
function platformPattern(unixPath: string): string {
  return path.resolve(unixPath);
}

/**
 * Sensitive path prefixes that should NEVER be writable.
 * These are system-critical or security-sensitive directories.
 */
const SENSITIVE_PATTERNS: { pattern: string; reason: string }[] = [
  // System directories
  { pattern: platformPattern('/etc'), reason: 'system configuration directory' },
  { pattern: platformPattern('/boot'), reason: 'boot loader directory' },
  { pattern: platformPattern('/sys'), reason: 'kernel sysfs' },
  { pattern: platformPattern('/proc'), reason: 'process information filesystem' },
  { pattern: platformPattern('/dev'), reason: 'device files' },
  { pattern: platformPattern('/usr/lib'), reason: 'system libraries' },
  { pattern: platformPattern('/usr/bin'), reason: 'system binaries' },
  { pattern: platformPattern('/usr/sbin'), reason: 'system admin binaries' },
  { pattern: platformPattern('/lib'), reason: 'system libraries' },
  { pattern: platformPattern('/bin'), reason: 'system binaries' },
  { pattern: platformPattern('/sbin'), reason: 'system admin binaries' },
  { pattern: platformPattern('/root'), reason: 'root user home directory' },

  // Security-sensitive
  { pattern: path.join(os.homedir(), '.ssh'), reason: 'SSH keys directory' },
  { pattern: path.join(os.homedir(), '.gnupg'), reason: 'GPG keys directory' },
  { pattern: path.join(os.homedir(), '.aws'), reason: 'AWS credentials directory' },
  { pattern: path.join(os.homedir(), '.gitconfig'), reason: 'global git configuration' },
];

/**
 * Check if a path points to a sensitive system location that should
 * never be written to, regardless of grant.
 *
 * @param p - The resolved absolute path to check
 * @returns `null` if the path is safe, or a `{ reason }` object if it is sensitive
 */
export function checkSensitivePath(p: string): { reason: string } | null {
  const normalized = path.resolve(p);

  for (const { pattern, reason } of SENSITIVE_PATTERNS) {
    // Match exact path or subdirectory
    if (normalized === pattern || normalized.startsWith(pattern + path.sep)) {
      return { reason };
    }
  }

  return null;
}
