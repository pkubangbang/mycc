/**
 * wt.ts - Worktree module: git worktree management
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WtModule, CoreModule } from '../../types.js';
import * as WorktreeStore from '../worktree-store.js';

/**
 * Parse git worktree list --porcelain output
 */
interface GitWorktreeInfo {
  path: string;
  commit: string;
  branch: string | null;
}

function parseGitWorktreeList(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = [];
  const lines = output.split('\n');
  let current: Partial<GitWorktreeInfo> | null = null;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current && current.path) {
        worktrees.push(current as GitWorktreeInfo);
      }
      current = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      if (current) current.commit = line.substring(5);
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.substring(7);
    }
  }

  // Add last worktree
  if (current && current.path) {
    worktrees.push(current as GitWorktreeInfo);
  }

  return worktrees;
}

/**
 * Worktree module implementation
 */
export class WorktreeManager implements WtModule {
  private core: CoreModule;

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Sync database with actual git worktrees
   * Call this at startup to reconcile any orphaned worktrees
   */
  async syncWorkTrees(): Promise<void> {
    const workDir = this.core.getWorkDir();

    try {
      // Get actual git worktrees
      const output = execSync('git worktree list --porcelain', {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr to suppress fatal messages
      });
      const gitWorktrees = parseGitWorktreeList(output);

      // Get stored records
      const storedRecords = WorktreeStore.loadWorktrees();

      // Build maps for comparison
      const storedByPath = new Map(storedRecords.map(r => [r.path, r]));
      const gitByPath = new Map(gitWorktrees.map(w => [w.path, w]));

      // Find orphaned records (in store but not in git)
      for (const record of storedRecords) {
        if (!gitByPath.has(record.path)) {
          // Remove orphaned record
          WorktreeStore.removeWorktree(record.name);
        }
      }

      // Find missing records (in git but not in store)
      for (const worktree of gitWorktrees) {
        // Skip the main worktree (project root)
        if (worktree.path === workDir) continue;

        // Skip worktrees outside .worktrees directory (user-created)
        if (!worktree.path.includes('.worktrees')) continue;

        if (!storedByPath.has(worktree.path)) {
          // Extract name from path
          const name = path.basename(worktree.path);
          const branch = worktree.branch ? path.basename(worktree.branch) : 'detached';

          // Add missing record
          WorktreeStore.addWorktree({
            name,
            path: worktree.path,
            branch,
            createdAt: new Date(),
          });
        }
      }
    } catch {
      // Git not available or no worktrees - ignore
    }
  }

  /**
   * Create a new git worktree
   */
  async createWorkTree(name: string, branch: string): Promise<string> {
    const workDir = this.core.getWorkDir();
    const wtPath = path.join(workDir, '.worktrees', name);

    // Check if worktree already exists
    const existing = WorktreeStore.getWorktree(name);
    if (existing) {
      return `Error: Worktree '${name}' already exists`;
    }

    try {
      // Create .worktrees directory if needed
      const wtDir = path.join(workDir, '.worktrees');
      if (!fs.existsSync(wtDir)) {
        fs.mkdirSync(wtDir, { recursive: true });
      }

      // Create worktree via git
      execSync(`git worktree add -b ${branch} "${wtPath}"`, {
        cwd: workDir,
        encoding: 'utf-8',
      });

      // Record in store (project-level, persists across sessions)
      WorktreeStore.addWorktree({
        name,
        path: wtPath,
        branch,
        createdAt: new Date(),
      });

      return `Created worktree '${name}' at ${wtPath} on branch ${branch}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  /**
   * List all worktrees
   */
  async printWorkTrees(): Promise<string> {
    const worktrees = WorktreeStore.loadWorktrees();

    if (worktrees.length === 0) {
      return 'No worktrees.';
    }

    const lines = ['Worktrees:'];
    for (const wt of worktrees) {
      lines.push(`  ${wt.name}: ${wt.branch} (${wt.path})`);
    }
    return lines.join('\n');
  }

  /**
   * Get the path to a worktree (read-only, no state change)
   */
  async getWorkTreePath(name: string): Promise<string> {
    const wt = WorktreeStore.getWorktree(name);

    if (!wt) {
      throw new Error(`Worktree '${name}' not found`);
    }

    if (!fs.existsSync(wt.path)) {
      throw new Error(`Worktree path does not exist: ${wt.path}`);
    }

    return wt.path;
  }

  /**
   * Get the project root (find .git directory)
   */
  async getProjectRoot(): Promise<string> {
    let currentDir = this.core.getWorkDir();
    while (currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, '.git'))) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    return this.core.getWorkDir();
  }

  /**
   * Enter a worktree (change working directory)
   */
  async enterWorkTree(name: string): Promise<void> {
    const wtPath = await this.getWorkTreePath(name);
    this.core.setWorkDir(wtPath);
  }

  /**
   * Leave current worktree (restore to project root)
   */
  async leaveWorkTree(): Promise<void> {
    const root = await this.getProjectRoot();
    this.core.setWorkDir(root);
  }

  /**
   * Remove a worktree
   * @throws Error if currently inside the worktree being removed
   */
  async removeWorkTree(name: string): Promise<void> {
    const wt = WorktreeStore.getWorktree(name);

    if (!wt) {
      return;
    }

    // Check if we're inside the worktree being removed
    const currentDir = this.core.getWorkDir();
    const targetPath = path.resolve(wt.path);
    const normalizedCurrent = path.resolve(currentDir);

    // Check if current directory is inside or is the worktree being removed
    if (normalizedCurrent === targetPath || normalizedCurrent.startsWith(targetPath + path.sep)) {
      throw new Error(
        `Cannot remove worktree '${name}' while inside it. Use wt_leave first to exit the worktree.`
      );
    }

    try {
      // Remove worktree via git
      execSync(`git worktree remove "${wt.path}"`, {
        cwd: this.core.getWorkDir(),
        encoding: 'utf-8',
      });
    } catch {
      // Force remove if normal remove fails
      try {
        execSync(`git worktree remove --force "${wt.path}"`, {
          cwd: this.core.getWorkDir(),
          encoding: 'utf-8',
        });
      } catch {
        // Ignore errors
      }
    }

    // Remove from store
    WorktreeStore.removeWorktree(name);
  }
}