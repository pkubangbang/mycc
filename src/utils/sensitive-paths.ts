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
 *
 * Stored as Unix-style prefixes (POSIX convention). On Windows a Unix-style
 * path like `/etc` has no drive, and `path.resolve('/etc')` resolves against
 * the PROCESS CWD's drive — so on a machine whose cwd is on `D:` it becomes
 * `D:\etc`, while a workspace/agent on `C:` resolving the same input yields
 * `C:\etc`. A single-drive pattern therefore matches on only one drive and the
 * security guard silently misses on the other. checkSensitivePath() below
 * matches these prefixes against the resolved path on a DRIVE-AGNOSTIC basis
 * (drive letter stripped on Windows) so the Unix-conventional system paths are
 * recognized on every drive.
 */
const SENSITIVE_PREFIXES: { prefix: string; reason: string }[] = [
  // System directories
  { prefix: '/etc', reason: 'system configuration directory' },
  { prefix: '/boot', reason: 'boot loader directory' },
  { prefix: '/sys', reason: 'kernel sysfs' },
  { prefix: '/proc', reason: 'process information filesystem' },
  { prefix: '/dev', reason: 'device files' },
  { prefix: '/usr/lib', reason: 'system libraries' },
  { prefix: '/usr/bin', reason: 'system binaries' },
  { prefix: '/usr/sbin', reason: 'system admin binaries' },
  { prefix: '/lib', reason: 'system libraries' },
  { prefix: '/bin', reason: 'system binaries' },
  { prefix: '/sbin', reason: 'system admin binaries' },
  { prefix: '/root', reason: 'root user home directory' },
];

/**
 * Normalize a path so it can be compared drive-agnostically on Windows.
 *
 * On Windows, strip a leading drive letter and a leading separator so
 * `C:\etc\passwd` and `D:\etc\passwd` both normalize to `\etc\passwd` (then
 * `/etc/passwd` after separator unification). On POSIX the input is already
 * absolute and needs only separator unification. This lets one Unix-style
 * sensitive prefix (`/etc`) match a resolved path on ANY drive.
 */
function normalizeForComparison(p: string): string {
  let n = path.resolve(p);
  // Strip a Windows drive prefix (e.g. "C:") if present.
  if (/^[A-Za-z]:/.test(n)) {
    n = n.slice(2);
  }
  return n.replace(/\\/g, '/');
}

/**
 * Check if a path points to a sensitive system location that should
 * never be written to, regardless of grant.
 *
 * Comparison is drive-agnostic on Windows (see normalizeForComparison): a
 * Unix-style prefix such as `/etc` matches the resolved path regardless of
 * which drive it resolves onto. Home-relative security paths (`.ssh`, `.gnupg`,
 * `.aws`, `.gitconfig`) are matched against the CURRENT user's home directory,
 * which is the correct anchor on both platforms.
 *
 * @param p - The resolved absolute path to check
 * @returns `null` if the path is safe, or a `{ reason }` object if it is sensitive
 */
export function checkSensitivePath(p: string): { reason: string } | null {
  const normalized = normalizeForComparison(p);

  for (const { prefix, reason } of SENSITIVE_PREFIXES) {
    // Drive-agnostic prefix match: exact or subdirectory.
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return { reason };
    }
  }

  // Home-relative security directories — anchored on the current user's home
  // (NOT a drive-guessed /root, which would only be right on POSIX where the
  // home IS /root). Compare drive-agnostically so a differently-cased or
  // differently-driven home path still matches.
  const homeAnchored: { suffix: string; reason: string }[] = [
    { suffix: normalizeForComparison(path.join(os.homedir(), '.ssh')), reason: 'SSH keys directory' },
    { suffix: normalizeForComparison(path.join(os.homedir(), '.gnupg')), reason: 'GPG keys directory' },
    { suffix: normalizeForComparison(path.join(os.homedir(), '.aws')), reason: 'AWS credentials directory' },
    { suffix: normalizeForComparison(path.join(os.homedir(), '.gitconfig')), reason: 'global git configuration' },
  ];
  for (const { suffix, reason } of homeAnchored) {
    if (normalized === suffix || normalized.startsWith(`${suffix}/`)) {
      return { reason };
    }
  }

  return null;
}
