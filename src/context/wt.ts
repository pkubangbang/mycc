/**
 * wt.ts - Worktree module: git worktree management
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WtModule } from '../types.js';
import { getDb } from './db.js';
import type { CoreModule } from '../types.js';

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
    const db = getDb();
    const workDir = this.core.getWorkDir();

    try {
      // Get actual git worktrees
      const output = execSync('git worktree list --porcelain', {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr to suppress fatal messages
      });
      const gitWorktrees = parseGitWorktreeList(output);

      // Get database records
      const dbRecords = db.prepare(`SELECT name, path, branch FROM worktrees`).all() as Array<{
        name: string;
        path: string;
        branch: string;
      }>;

      // Build maps for comparison
      const dbByPath = new Map(dbRecords.map(r => [r.path, r]));
      const gitByPath = new Map(gitWorktrees.map(w => [w.path, w]));

      // Find orphaned DB records (in DB but not in git)
      for (const record of dbRecords) {
        if (!gitByPath.has(record.path)) {
          // Remove orphaned record
          db.prepare(`DELETE FROM worktrees WHERE name = ?`).run(record.name);
        }
      }

      // Find missing DB records (in git but not in DB)
      for (const worktree of gitWorktrees) {
        // Skip the main worktree (project root)
        if (worktree.path === workDir) continue;

        // Skip worktrees outside .worktrees directory (user-created)
        if (!worktree.path.includes('.worktrees')) continue;

        if (!dbByPath.has(worktree.path)) {
          // Extract name from path
          const name = path.basename(worktree.path);
          const branch = worktree.branch ? path.basename(worktree.branch) : 'detached';

          // Add missing record
          db.prepare(`
            INSERT OR IGNORE INTO worktrees (name, path, branch)
            VALUES (?, ?, ?)
          `).run(name, worktree.path, branch);
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
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM worktrees WHERE name = ?`).get(name);
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

      // Record in database (project-level, not session-scoped)
      db.prepare(`
        INSERT INTO worktrees (name, path, branch)
        VALUES (?, ?, ?)
      `).run(name, wtPath, branch);

      return `Created worktree '${name}' at ${wtPath} on branch ${branch}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  /**
   * List all worktrees
   */
  async printWorkTrees(): Promise<string> {
    const db = getDb();
    const rows = db.prepare(`SELECT name, path, branch FROM worktrees`).all() as Array<{
      name: string;
      path: string;
      branch: string;
    }>;

    if (rows.length === 0) {
      return 'No worktrees.';
    }

    const lines = ['Worktrees:'];
    for (const row of rows) {
      lines.push(`  ${row.name}: ${row.branch} (${row.path})`);
    }
    return lines.join('\n');
  }

  /**
   * Get the path to a worktree (read-only, no state change)
   */
  async getWorkTreePath(name: string): Promise<string> {
    const db = getDb();
    const row = db.prepare(`SELECT path FROM worktrees WHERE name = ?`).get(name) as {
      path: string;
    } | undefined;

    if (!row) {
      throw new Error(`Worktree '${name}' not found`);
    }

    if (!fs.existsSync(row.path)) {
      throw new Error(`Worktree path does not exist: ${row.path}`);
    }

    return row.path;
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
    const db = getDb();
    const row = db.prepare(`SELECT path FROM worktrees WHERE name = ?`).get(name) as {
      path: string;
    } | undefined;

    if (!row) {
      return;
    }

    // Check if we're inside the worktree being removed
    const currentDir = this.core.getWorkDir();
    const targetPath = path.resolve(row.path);
    const normalizedCurrent = path.resolve(currentDir);

    // Check if current directory is inside or is the worktree being removed
    if (normalizedCurrent === targetPath || normalizedCurrent.startsWith(targetPath + path.sep)) {
      throw new Error(
        `Cannot remove worktree '${name}' while inside it. Use wt_leave first to exit the worktree.`
      );
    }

    try {
      // Remove worktree via git
      execSync(`git worktree remove "${row.path}"`, {
        cwd: this.core.getWorkDir(),
        encoding: 'utf-8',
      });
    } catch {
      // Force remove if normal remove fails
      try {
        execSync(`git worktree remove --force "${row.path}"`, {
          cwd: this.core.getWorkDir(),
          encoding: 'utf-8',
        });
      } catch {
        // Ignore errors
      }
    }

    // Remove from database
    db.prepare(`DELETE FROM worktrees WHERE name = ?`).run(name);
  }
}