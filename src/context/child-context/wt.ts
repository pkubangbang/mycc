/**
 * wt.ts - ChildWt implementation for worktree operations
 *
 * Note: enterWorkTree and leaveWorkTree update the child's local workDir directly,
 * without IPC. Only read operations (get path, list) need to query parent.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WtModule, CoreModule } from '../../types.js';
import { ipc } from './ipc-helpers.js';

/**
 * Find project root by traversing up looking for .git
 */
function findProjectRoot(startDir: string): string {
  let currentDir = startDir;
  while (currentDir !== path.dirname(currentDir)) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return startDir;
}

/**
 * Worktree module for child process
 * enter/leave update local workDir directly, other operations use IPC
 */
export class ChildWt implements WtModule {
  private core: CoreModule;

  constructor(core: CoreModule) {
    this.core = core;
  }

  async syncWorkTrees(): Promise<void> {
    // Sync is done by parent at startup, no-op in child
  }

  async createWorkTree(name: string, branch: string): Promise<string> {
    const result = await ipc.sendRequest<{ path: string }>('wt_create', { name, branch });
    return result.path;
  }

  async printWorkTrees(): Promise<string> {
    const result = await ipc.sendRequest<string>('wt_print', {});
    return result;
  }

  async getWorkTreePath(name: string): Promise<string> {
    const result = await ipc.sendRequest<{ path: string }>('wt_get_path', { name });
    return result.path;
  }

  async enterWorkTree(name: string): Promise<void> {
    // Get path from parent, then update local workDir
    const wtPath = await this.getWorkTreePath(name);
    this.core.setWorkDir(wtPath);
  }

  async leaveWorkTree(): Promise<void> {
    // Find project root locally and update workDir
    const root = findProjectRoot(this.core.getWorkDir());
    this.core.setWorkDir(root);
  }

  async removeWorkTree(name: string): Promise<void> {
    // Check if we're inside the worktree being removed (local check first)
    const db = await this.getWorkTreePath(name).catch(() => null);
    if (db) {
      const targetPath = path.resolve(db);
      const normalizedCurrent = path.resolve(this.core.getWorkDir());

      if (normalizedCurrent === targetPath || normalizedCurrent.startsWith(targetPath + path.sep)) {
        throw new Error(
          `Cannot remove worktree '${name}' while inside it. Use wt_leave first to exit the worktree.`
        );
      }
    }

    await ipc.sendRequest<void>('wt_remove', { name });
  }
}