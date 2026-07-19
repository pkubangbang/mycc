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
 * Indirect/observation wrappers — commands that do NOT themselves execute the
 * dangerous payload; they observe or drive a session whose execution was
 * authorized elsewhere (e.g. via hand_over). The dangerous-pattern check is
 * SKIPPED for these so observation of an already-authorized session is allowed.
 *
 * NOTE: `tmux send-keys` is intentionally NOT in this list — it executes the
 * payload in the target pane, so it must still route through the dangerous
 * check (and, with `dangerous=i_know`, through user confirmation).
 */
const INDIRECT_WRAPPERS: RegExp[] = [
  /\btmux\s+(?:capture-pane|show|display-message|list-sessions|list-windows|list-panes|show-options)\b/,
];

/**
 * Execution wrappers — commands that indirectly execute a payload. These are
 * ALWAYS checked even when wrapped in an indirect wrapper, so obfuscation
 * (sh -c 'mkfs...', eval, $(), xargs, find -exec) cannot bypass the dangerous
 * pattern match.
 */
const EXEC_WRAPPERS: RegExp[] = [
  /\bsh\s+-c\b/,
  /\bbash\s+-c\b/,
  /\beval\b/,
  /\$\(/, // command substitution $(...)
  /`/, // backtick command substitution
  /\bxargs\b/,
  /\bfind\b.*-exec\b/,
];

/**
 * Check whether the command is an indirect/observation wrapper (and NOT also
 * an execution wrapper). When true, the dangerous-pattern check is skipped.
 */
function isIndirectObservation(command: string): boolean {
  if (!INDIRECT_WRAPPERS.some((re) => re.test(command))) return false;
  // If an exec wrapper is also present, the payload executes indirectly → do NOT skip.
  if (EXEC_WRAPPERS.some((re) => re.test(command))) return false;
  return true;
}

/**
 * Find the first dangerous-command pattern that matches the command.
 * Returns the full DangerousCommand (with category) or null.
 *
 * Skips the dangerous-pattern check for pure observation/indirect wrappers
 * (e.g. `tmux capture-pane`), unless an execution wrapper is also present.
 */
export function findDangerousCommand(command: string): DangerousCommand | null {
  if (isIndirectObservation(command)) return null;
  for (const dc of DANGEROUS_COMMANDS) {
    if (dc.pattern.test(command)) {
      return dc;
    }
  }
  return null;
}

/**
 * Check if command matches a dangerous pattern
 * @param command - The bash command to check
 * @returns Object indicating if blocked and reason
 *
 * Backward-compatible thin wrapper over findDangerousCommand. bash-judge uses
 * findDangerousCommand directly so it can read the category and offer the
 * `dangerous=i_know` escape hatch for destructive/irreversible categories.
 */
export function checkDangerousCommand(command: string): { blocked: boolean; reason?: string } {
  const dc = findDangerousCommand(command);
  if (dc) {
    return { blocked: true, reason: dc.reason };
  }
  return { blocked: false };
}
