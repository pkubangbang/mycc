/**
 * grant-evaluator.ts - Main grant evaluator for all tools
 */

import type { Core } from '../parent/core.js';
import { judgeBash } from './bash-judge.js';
import { loadWorktrees } from '../worktree-store.js';
import * as path from 'path';
import type { GrantRequest } from './types.js';

// Re-export types for convenience
export type { GrantRequest, GrantTool } from './types.js';

/**
 * Evaluate a grant request from a child process or tool
 * 
 * For bash: Uses the 5-step judging process
 * For files: Checks mode and worktree ownership
 */
export async function evaluateGrant(
  sender: string,
  request: GrantRequest,
  core: Core
): Promise<{ approved: boolean; reason?: string }> {
  const mode = core.getMode();
  const isChildProcess = sender !== 'lead';

  // Handle bash tool
  if (request.tool === 'bash') {
    if (!request.command) {
      return { approved: false, reason: 'No command provided for bash tool' };
    }

    const result = await judgeBash(
      request.command,
      request.intent || '',
      mode,
      isChildProcess,
      core.question.bind(core),  // Pass askUser function
      core.escAware.bind(core)   // Pass escAware function for ESC handling
    );

    return {
      approved: result.decision === 'allow',
      reason: result.reason,
    };
  }

  // Handle file operations (write_file, edit_file)
  if (mode === 'plan') {
    // Check allowed file for plan mode
    const allowedFile = core.getAllowedFile();
    
    if (request.path && allowedFile) {
      const resolvedRequested = path.isAbsolute(request.path)
        ? request.path
        : path.resolve(core.getWorkDir(), request.path);
      const resolvedAllowed = path.isAbsolute(allowedFile)
        ? allowedFile
        : path.resolve(core.getWorkDir(), allowedFile);

      if (resolvedRequested === resolvedAllowed) {
        return { approved: true };
      }
    }

    return {
      approved: false,
      reason: `Plan mode is ACTIVE - code changes are temporarily restricted.${allowedFile ? ` Only ${allowedFile} can be edited.` : ''}`,
    };
  }

  // Normal mode for file operations: check worktree ownership (child processes)
  if (isChildProcess) {
    if (!request.path) {
      return { approved: false, reason: `No path provided for ${request.tool}` };
    }

    const worktrees = loadWorktrees();
    const ownedWt = worktrees.find(wt => wt.name === sender);

    if (ownedWt) {
      const resolved = path.resolve(core.getWorkDir(), request.path);
      if (resolved.startsWith(ownedWt.path)) {
        return { approved: true }; // Auto-grant for owned worktree
      }
    }

    // No owned worktree — fall back to allowing writes within the project root.
    // This supports teammates spawned for general project work (not worktree-specific tasks).
    const resolved = path.resolve(core.getWorkDir(), request.path);
    if (resolved.startsWith(core.getWorkDir())) {
      return { approved: true };
    }

    return {
      approved: false,
      reason: `'${request.path}' is outside your worktree. Teammates can only modify files within their assigned worktree.`,
    };
  }

  // Normal mode for lead (parent): allow
  return { approved: true };
}