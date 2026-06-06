/**
 * dangerous-commands.ts - Pattern-based blocking for dangerous commands
 */

import type { DangerousCommand } from './types.js';

/**
 * List of dangerous command patterns
 * Extensible - add new patterns here
 */
export const DANGEROUS_COMMANDS: DangerousCommand[] = [
  // ── Privileged operations (before root/home patterns — more specific) ──
  {
    pattern: /\bsudo\b.*\brm\b/i,
    reason: 'Privileged deletion',
    category: 'destructive',
  },
  {
    pattern: /\bsudo\b.*\bchmod\b.*\b000\b/i,
    reason: 'Privileged permission removal',
    category: 'destructive',
  },

  // ── Root-level deletions ───────────────────────────────────────────
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(?:--?[a-zA-Z][a-zA-Z-]*\s+)*\/(?:\*|\s|$)/i,
    reason: 'Recursive delete from root directory',
    category: 'destructive',
  },

  // ── Current-directory deletions ─────────────────────────────────────
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(?:--?[a-zA-Z][a-zA-Z-]*\s+)*\.(?:\s|$)/,
    reason: 'Recursive delete of current directory',
    category: 'destructive',
  },

  // ── Home-directory deletions ────────────────────────────────────────
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(?:--?[a-zA-Z][a-zA-Z-]*\s+)*~(?:\/|\s|$)/i,
    reason: 'Recursive deletion in home directory',
    category: 'destructive',
  },

  // ── Batch deletions (defense-in-depth; also gated in bash-judge step 4)
  {
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)?[^/\s]*\*[^/\s]*$/,
    reason: 'Batch deletion with glob pattern',
    category: 'destructive',
  },

  // ── Irreversible operations ─────────────────────────────────────────
  {
    pattern: /\bmkfs\b/i,
    reason: 'Filesystem formatting',
    category: 'irreversible',
  },
  {
    pattern: /\bdd\b.*\bif=/i,
    reason: 'Disk imaging operation',
    category: 'irreversible',
  },
  {
    pattern: /\bshutdown\b/i,
    reason: 'System shutdown',
    category: 'irreversible',
  },
  {
    pattern: /\breboot\b/i,
    reason: 'System reboot',
    category: 'irreversible',
  },

  // ── Git operations (should use dedicated tools) ─────────────────────
  {
    pattern: /\bgit\s+commit\b/i,
    reason: 'Use git_commit tool instead',
    category: 'system',
  },
  {
    pattern: /\bgit\s+push\s+.*--force(?:$|\s)/i,
    reason: 'Force push',
    category: 'destructive',
  },
  {
    pattern: /\bgit\s+push\s+.*(?<!\S)-f(?:$|\s)/i,
    reason: 'Force push (-f)',
    category: 'destructive',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: 'Hard reset discards working changes',
    category: 'destructive',
  },

  // ── Package publishing ──────────────────────────────────────────────
  {
    pattern: /\bnpm\s+publish\b/i,
    reason: 'Package publishing requires manual confirmation',
    category: 'system',
  },
  {
    pattern: /\b(?:twine|python\s+(?:-m\s+)?twine)\s+upload\b/i,
    reason: 'Package publishing requires manual confirmation',
    category: 'system',
  },
];

/**
 * Check if command matches a dangerous pattern
 * @param command - The bash command to check
 * @returns Object indicating if blocked and reason
 */
export function checkDangerousCommand(command: string): { blocked: boolean; reason?: string } {
  for (const dc of DANGEROUS_COMMANDS) {
    if (dc.pattern.test(command)) {
      return { blocked: true, reason: dc.reason };
    }
  }
  return { blocked: false };
}
