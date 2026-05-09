/**
 * dangerous-commands.ts - Pattern-based blocking for dangerous commands
 */

import type { DangerousCommand } from './types.js';

/**
 * List of dangerous command patterns
 * Extensible - add new patterns here
 */
export const DANGEROUS_COMMANDS: DangerousCommand[] = [
  // Destructive operations
  { 
    pattern: /\brm\s+(-[rf]+\s+)*\//i, 
    reason: 'Recursive delete from root directory', 
    category: 'destructive' 
  },
  { 
    pattern: /\bsudo\s+rm\b/i, 
    reason: 'Privileged deletion', 
    category: 'destructive' 
  },
  { 
    pattern: /\bsudo\s+chmod\s+000/i, 
    reason: 'Privileged permission removal', 
    category: 'destructive' 
  },
  
  // Irreversible operations
  { 
    pattern: /\bmkfs\b/i, 
    reason: 'Filesystem formatting', 
    category: 'irreversible' 
  },
  { 
    pattern: /\bdd\s+if=/i, 
    reason: 'Disk imaging operation', 
    category: 'irreversible' 
  },
  { 
    pattern: /\bshutdown\b/i, 
    reason: 'System shutdown', 
    category: 'irreversible' 
  },
  { 
    pattern: /\breboot\b/i, 
    reason: 'System reboot', 
    category: 'irreversible' 
  },
  
  // Git operations (should use dedicated tools)
  { 
    pattern: /\bgit\s+commit\b/i, 
    reason: 'Use git_commit tool instead', 
    category: 'system' 
  },
  { 
    pattern: /\bgit\s+push\s+--force\b/i, 
    reason: 'Force push is dangerous', 
    category: 'destructive' 
  },
  
  // Package publishing
  { 
    pattern: /\bnpm\s+publish\b/i, 
    reason: 'Package publishing requires manual confirmation', 
    category: 'system' 
  },
  { 
    pattern: /\bpip\s+upload\b/i, 
    reason: 'Package publishing requires manual confirmation', 
    category: 'system' 
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