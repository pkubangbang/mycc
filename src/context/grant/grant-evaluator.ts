/**
 * grant-evaluator.ts - Main grant evaluator for all tools
 */

import type { Core } from '../parent/core.js';
import { judgeBash } from './bash-judge.js';
import { listWorktrees } from '../worktree-store.js';
import { getPlanModeWritableDirs } from '../../config.js';
import * as path from 'path';
import type { GrantRequest } from './types.js';

// Re-export types for convenience
export type { GrantRequest, GrantTool } from './types.js';

/**
 * Check whether a resolved absolute path falls inside one of the
 * plan-mode-writable tool-output directories (e.g. .mycc/longtext,
 * .mycc/imgcache). These hold transient analysis artifacts, not project
 * source code, so writing to them does not violate plan-mode's read-only
 * contract. Used to unblock teammates/tools that emit long-text dumps or
 * image-description caches while the lead is in plan mode.
 *
 * @param resolvedPath - Absolute path of the requested write target
 * @param workDir - Absolute project work directory (dirs are resolved under it)
 * @returns true if the path is inside a plan-mode-writable directory
 */
export function isPlanModeWritablePath(resolvedPath: string, workDir: string): boolean {
  const sep = path.sep;
  for (const rel of getPlanModeWritableDirs()) {
    const dirAbs = path.isAbsolute(rel) ? rel : path.resolve(workDir, rel);
    // Match the directory itself or anything strictly beneath it.
    if (resolvedPath === dirAbs || resolvedPath.startsWith(dirAbs + sep)) {
      return true;
    }
  }
  return false;
}

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
      // Forward options (e.g. onEsc) so bash-judge callers can pass a
      // default for ESC — dangerous/batch confirmations default to 'n'.
      (query: string, asker: string, options?: { onEsc?: string }) =>
        core.question(query, asker, options),
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

    // Allow writes into plan-mode-writable tool-output directories
    // (e.g. .mycc/longtext, .mycc/imgcache). These hold transient analysis
    // artifacts, not project source, so they stay writable in plan mode —
    // unblocking teammates/tools that dump long text or image descriptions.
    if (request.path) {
      const resolvedRequested = path.isAbsolute(request.path)
        ? request.path
        : path.resolve(core.getWorkDir(), request.path);
      if (isPlanModeWritablePath(resolvedRequested, core.getWorkDir())) {
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

    const worktrees = await listWorktrees(core.getWorkDir());
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