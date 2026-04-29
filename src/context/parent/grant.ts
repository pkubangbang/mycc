/**
 * grant.ts - Grant evaluator for child process permission requests
 *
 * Evaluates grant requests from child processes:
 * 1. Check mode (plan mode blocks all code changes)
 * 2. Check worktree ownership (children can only modify their own worktree)
 */

import * as path from 'path';
import type { Core } from './core.js';
import { loadWorktrees } from '../worktree-store.js';

/**
 * Grant request types
 */
export type GrantTool = 'write_file' | 'edit_file' | 'bash';

export interface GrantRequest {
  tool: GrantTool;
  path?: string;
  command?: string;
}

/**
 * Evaluate a grant request from a child process
 * @param sender - Name of the child process making the request
 * @param request - The grant request details
 * @param core - The parent's Core instance (for mode checking)
 * @returns Grant result with approval status and optional reason
 */
export async function evaluateGrant(
  sender: string,
  request: GrantRequest,
  core: Core
): Promise<{ approved: boolean; reason?: string }> {
  // 1. Check mode first
  if (core.getMode() === 'plan') {
    return {
      approved: false,
      reason: 'Code changes are prohibited in plan mode.',
    };
  }

  // 2. File operations (write_file, edit_file)
  if (request.tool === 'write_file' || request.tool === 'edit_file') {
    if (!request.path) {
      return {
        approved: false,
        reason: `No path provided for ${request.tool} operation.`,
      };
    }

    // Check if sender owns a worktree
    const worktrees = loadWorktrees();
    const ownedWt = worktrees.find(wt => wt.name === sender);

    if (ownedWt) {
      // Resolve the path relative to the project root
      const resolved = path.resolve(core.getWorkDir(), request.path);
      if (resolved.startsWith(ownedWt.path)) {
        return { approved: true }; // Auto-grant for owned worktree
      }
    }

    return {
      approved: false,
      reason: `'${request.path}' is outside your worktree. Teammates can only modify files within their assigned worktree.`,
    };
  }

  // 3. Bash commands
  if (request.tool === 'bash') {
    if (!request.command) {
      return {
        approved: false,
        reason: 'No command provided for bash operation.',
      };
    }

    // Block dangerous commands
    const dangerous = ['rm -rf /', 'sudo rm', 'mkfs', 'dd if='];
    if (dangerous.some(d => request.command?.includes(d))) {
      return { approved: false, reason: 'Dangerous command blocked.' };
    }

    // Block git commit (must use git_commit tool)
    if (/\bgit\s+commit\b/.test(request.command)) {
      return { approved: false, reason: 'Use git_commit tool instead.' };
    }

    // Auto-grant for owned worktree
    const worktrees = loadWorktrees();
    const ownedWt = worktrees.find(wt => wt.name === sender);
    if (ownedWt) {
      return { approved: true };
    }

    // Allow read-only commands for children without worktree
    const readOnly = /^git (status|log|diff|branch|show)/.test(request.command);
    if (readOnly) {
      return { approved: true };
    }

    return {
      approved: false,
      reason: `Cannot run '${request.command.slice(0, 50)}...' without an assigned worktree.`,
    };
  }

  return { approved: false, reason: `Unknown tool: ${request.tool}` };
}