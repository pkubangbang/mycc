/**
 * bg.ts - Background tasks module: run bash commands in background
 */

import { spawn, ChildProcess } from 'child_process';
import type { BgModule, BgTask, CoreModule } from '../../types.js';

/**
 * Background tasks module implementation
 */
export class BackgroundTasks implements BgModule {
  private core: CoreModule;
  private tasks: Map<number, BgTask> = new Map();
  private processes: Map<number, ChildProcess> = new Map();

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Run a command in the background
   */
  async runCommand(cmd: string): Promise<number> {
    const child = spawn(cmd, [], {
      cwd: this.core.getWorkDir(),
      shell: true,
      detached: true,
    });

    const pid = child.pid || Date.now();
    const task: BgTask = {
      pid,
      command: cmd,
      startTime: new Date(),
      status: 'running',
    };

    this.tasks.set(pid, task);
    this.processes.set(pid, child);

    // Handle output — accumulate silently, viewable via bg_print
    child.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (task.output) {
        task.output += output;
      } else {
        task.output = output;
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (task.output) {
        task.output += output;
      } else {
        task.output = output;
      }
    });

    // Handle completion
    child.on('close', (code) => {
      task.status = code === 0 ? 'completed' : 'failed';
    });

    child.on('error', (_err) => {
      task.status = 'failed';
    });

    return pid;
  }

  /**
   * Format background tasks for prompt
   */
  async printBgTasks(): Promise<string> {
    if (this.tasks.size === 0) {
      return 'No background tasks.';
    }

    const lines = ['Background tasks:'];
    for (const [pid, task] of this.tasks) {
      const status: Record<string, string> = {
        running: '[running]',
        completed: '[done]',
        failed: '[failed]',
      };
      lines.push(`  ${status[task.status] || '[?]'} ${pid}: ${task.command}`);
    }
    return lines.join('\n');
  }

  /**
   * Check if there are running tasks
   */
  async hasRunningBgTasks(): Promise<boolean> {
    return Array.from(this.tasks.values()).some((t) => t.status === 'running');
  }

  /**
   * Kill a background task
   */
  async killTask(pid: number): Promise<void> {
    const process = this.processes.get(pid);
    if (process) {
      try {
        process.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
      this.processes.delete(pid);
    }

    const task = this.tasks.get(pid);
    if (task) {
      task.status = 'failed';
    }
  }

  /**
   * Get task by pid (for testing)
   */
  getTask(pid: number): BgTask | undefined {
    return this.tasks.get(pid);
  }
}