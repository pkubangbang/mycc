/**
 * wt.ts - Worktree module: git worktree management
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WtModule, WorkTree, IpcHandlerRegistration } from '../types.js';
import { getDb } from './db.js';
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
  createWorkTree(name: string, branch: string): string {
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

      // Record in database
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
  printWorkTrees(): string {
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
   * Enter a worktree (change working directory)
   */
  enterWorkTree(name: string): void {
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

    this.core.setWorkDir(row.path);
  }

  /**
   * Leave current worktree (restore to project root)
   */
  leaveWorkTree(): void {
    // Find the project root by looking for .git directory
    let currentDir = this.core.getWorkDir();
    while (currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, '.git'))) {
        this.core.setWorkDir(currentDir);
        return;
      }
      currentDir = path.dirname(currentDir);
    }

    // If no .git found, stay in current directory
  }

  /**
   * Remove a worktree
   */
  removeWorkTree(name: string): void {
    const db = getDb();
    const row = db.prepare(`SELECT path FROM worktrees WHERE name = ?`).get(name) as {
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
    db.prepare(`DELETE FROM worktrees WHERE name = ?`).run(name);
  }
}

/**
 * Create a worktree module instance
 */
export function createWt(core: CoreModule): WtModule {
  return new WorktreeManager(core);
}

/**
 * Create IPC handlers for Worktree module
 * These handle wt requests from child processes
 */
export function createWtIpcHandlers(): IpcHandlerRegistration[] {
  return [
    {
      messageType: 'wt_create',
      module: 'wt',
      handler: async (_sender, payload, ctx) => {
        const { name, branch } = payload as { name: string; branch: string };
        const result = await ctx.wt.createWorkTree(name, branch);
        // Parse path from result string
        const match = result.match(/at (.+) on branch/);
        const wtPath = match ? match[1] : '';
        return { success: true, data: { path: wtPath } };
      },
    },
    {
      messageType: 'wt_print',
      module: 'wt',
      handler: async (_sender, _payload, ctx) => {
        const output = await ctx.wt.printWorkTrees();
        return { success: true, data: output };
      },
    },
    {
      messageType: 'wt_enter',
      module: 'wt',
      handler: async (_sender, payload, ctx) => {
        const { name } = payload as { name: string };
        try {
          await ctx.wt.enterWorkTree(name);
          const workDir = ctx.core.getWorkDir();
          return { success: true, data: { path: workDir } };
        } catch (err) {
          return { success: false, error: (err as Error).message };
        }
      },
    },
    {
      messageType: 'wt_leave',
      module: 'wt',
      handler: async (_sender, _payload, ctx) => {
        await ctx.wt.leaveWorkTree();
        const workDir = ctx.core.getWorkDir();
        return { success: true, data: { path: workDir } };
      },
    },
    {
      messageType: 'wt_remove',
      module: 'wt',
      handler: async (_sender, payload, ctx) => {
        const { name } = payload as { name: string };
        await ctx.wt.removeWorkTree(name);
        return { success: true };
      },
    },
  ];
}