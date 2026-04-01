/**
 * wt.ts - ChildWt implementation for IPC-based worktree operations
 */

import type { WtModule } from '../../types.js';
import { ipc } from './ipc-helpers.js';

/**
 * Worktree module reference to update workDir in core
 * This is set during child context creation
 */
let coreSetWorkDir: ((dir: string) => void) | null = null;

/**
 * Set the workDir update function (called from child context factory)
 */
export function setWorkDirUpdateFn(fn: (dir: string) => void): void {
  coreSetWorkDir = fn;
}

/**
 * Worktree module for child process
 * All operations go through IPC to parent
 */
export class ChildWt implements WtModule {
  async createWorkTree(name: string, branch: string): Promise<string> {
    const result = await ipc.sendRequest<{ path: string }>('wt_create', { name, branch });
    return result.path;
  }

  async printWorkTrees(): Promise<string> {
    const result = await ipc.sendRequest<string>('wt_print', {});
    return result;
  }

  async enterWorkTree(name: string): Promise<void> {
    const result = await ipc.sendRequest<{ path: string }>('wt_enter', { name });
    // Update local workDir
    if (coreSetWorkDir && result.path) {
      coreSetWorkDir(result.path);
    }
  }

  async leaveWorkTree(): Promise<void> {
    const result = await ipc.sendRequest<{ path: string }>('wt_leave', {});
    // Update local workDir
    if (coreSetWorkDir && result.path) {
      coreSetWorkDir(result.path);
    }
  }

  async removeWorkTree(name: string): Promise<void> {
    await ipc.sendRequest<void>('wt_remove', { name });
  }
}

/**
 * Create a child worktree module
 */
export function createChildWt(): WtModule {
  return new ChildWt();
}