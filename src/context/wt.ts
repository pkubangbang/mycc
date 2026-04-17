/**
 * wt.ts - Worktree module: git worktree management
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WtModule } from '../types.js';
import { getDb, getSessionContext } from './db.js';
import type { CoreModule } from '../types.js';

/**
 * Worktree module implementation
 */
export class WorktreeManager implements WtModule {
  private core: CoreModule;

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Create a new git worktree
   */
  async createWorkTree(name: string, branch: string): Promise<string> {
    const workDir = this.core.getWorkDir();
    const wtPath = path.join(workDir, '.worktrees', name);
    const sessionId = getSessionContext();

    // Check if worktree already exists
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM worktrees WHERE name = ? AND session_id = ?`).get(name, sessionId);
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

      // Record in database
      db.prepare(`
        INSERT INTO worktrees (name, path, branch, session_id)
        VALUES (?, ?, ?, ?)
      `).run(name, wtPath, branch, sessionId);

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
    const sessionId = getSessionContext();
    const rows = db.prepare(`SELECT name, path, branch FROM worktrees WHERE session_id = ?`).all(sessionId) as Array<{
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
    const sessionId = getSessionContext();
    const row = db.prepare(`SELECT path FROM worktrees WHERE name = ? AND session_id = ?`).get(name, sessionId) as {
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
   */
  async removeWorkTree(name: string): Promise<void> {
    const db = getDb();
    const sessionId = getSessionContext();
    const row = db.prepare(`SELECT path FROM worktrees WHERE name = ? AND session_id = ?`).get(name, sessionId) as {
      path: string;
    } | undefined;

    if (!row) {
      return;
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
    db.prepare(`DELETE FROM worktrees WHERE name = ? AND session_id = ?`).run(name, sessionId);
  }
}