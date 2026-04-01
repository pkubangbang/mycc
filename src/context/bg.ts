/**
 * bg.ts - Background tasks module: run bash commands in background
 */

import { spawn, ChildProcess } from 'child_process';
import type { BgModule, BgTask, BgTaskStatus, IpcHandlerRegistration } from '../types.js';
import type { CoreModule } from '../types.js';

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
  runCommand(cmd: string): number {
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

    // Handle output
    child.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (task.output) {
        task.output += output;
      } else {
        task.output = output;
      }
      this.core.brief('info', `bg:${pid}`, output.trim().slice(0, 100));
    });

    child.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (task.output) {
        task.output += output;
      } else {
        task.output = output;
      }
      this.core.brief('error', `bg:${pid}`, output.trim().slice(0, 100));
    });

    // Handle completion
    child.on('close', (code) => {
      task.status = code === 0 ? 'completed' : 'failed';
      this.core.brief('info', `bg:${pid}`, `Process exited with code ${code}`);
    });

    child.on('error', (err) => {
      task.status = 'failed';
      this.core.brief('error', `bg:${pid}`, `Process error: ${err.message}`);
    });

    return pid;
  }

  /**
   * Format background tasks for prompt
   */
  printBgTasks(): string {
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
  hasRunningBgTasks(): boolean {
    return Array.from(this.tasks.values()).some((t) => t.status === 'running');
  }

  /**
   * Kill a background task
   */
  killTask(pid: number): void {
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

/**
 * Create a background tasks module instance
 */
export function createBg(core: CoreModule): BgModule {
  return new BackgroundTasks(core);
}

/**
 * Create IPC handlers for Background Tasks module
 * These handle bg requests from child processes
 */
export function createBgIpcHandlers(): IpcHandlerRegistration[] {
  return [
    {
      messageType: 'bg_run',
      module: 'bg',
      handler: async (_sender, payload, ctx) => {
        const { cmd } = payload as { cmd: string };
        const pid = ctx.bg.runCommand(cmd);
        return { success: true, data: { pid } };
      },
    },
    {
      messageType: 'bg_print',
      module: 'bg',
      handler: (_sender, _payload, ctx) => {
        const output = ctx.bg.printBgTasks();
        return { success: true, data: output };
      },
    },
    {
      messageType: 'bg_has_running',
      module: 'bg',
      handler: (_sender, _payload, ctx) => {
        const running = ctx.bg.hasRunningBgTasks();
        return { success: true, data: { running } };
      },
    },
    {
      messageType: 'bg_kill',
      module: 'bg',
      handler: (_sender, payload, ctx) => {
        const { pid } = payload as { pid: number };
        ctx.bg.killTask(pid);
        return { success: true };
      },
    },
  ];
}