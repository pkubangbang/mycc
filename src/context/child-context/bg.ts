/**
 * bg.ts - ChildBg implementation for IPC-based background task operations
 */

import type { BgModule } from '../../types.js';
import { sendRequest } from './ipc-helpers.js';

/**
 * Background task module for child process
 * All operations go through IPC to parent
 */
export class ChildBg implements BgModule {
  async runCommand(cmd: string): Promise<number> {
    const result = await sendRequest<{ pid: number }>('bg_run', { cmd });
    return result.pid;
  }

  async printBgTasks(): Promise<string> {
    const result = await sendRequest<string>('bg_print', {});
    return result;
  }

  async hasRunningBgTasks(): Promise<boolean> {
    const result = await sendRequest<{ running: boolean }>('bg_has_running', {});
    return result.running;
  }

  async killTask(pid: number): Promise<void> {
    await sendRequest<void>('bg_kill', { pid });
  }
}

/**
 * Create a child background task module
 */
export function createChildBg(): BgModule {
  return new ChildBg();
}