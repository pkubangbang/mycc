/**
 * sensitive-paths.ts - Sensitive path detection
 *
 * Used by write_file and edit_file to block access to system
 * and security-critical paths, even if a grant is obtained.
 */

import * as path from 'path';
import * as os from 'os';

/**
 * Sensitive path prefixes that should NEVER be writable.
 * These are system-critical or security-sensitive directories.
 */
const SENSITIVE_PATTERNS: { pattern: string; reason: string }[] = [
  // System directories
  { pattern: '/etc', reason: 'system configuration directory' },
  { pattern: '/boot', reason: 'boot loader directory' },
  { pattern: '/sys', reason: 'kernel sysfs' },
  { pattern: '/proc', reason: 'process information filesystem' },
  { pattern: '/dev', reason: 'device files' },
  { pattern: '/usr/lib', reason: 'system libraries' },
  { pattern: '/usr/bin', reason: 'system binaries' },
  { pattern: '/usr/sbin', reason: 'system admin binaries' },
  { pattern: '/lib', reason: 'system libraries' },
  { pattern: '/bin', reason: 'system binaries' },
  { pattern: '/sbin', reason: 'system admin binaries' },
  { pattern: '/root', reason: 'root user home directory' },

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
