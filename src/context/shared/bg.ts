/**
 * bg.ts - Background tasks module: run bash commands in background
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import type { BgModule, BgTask, CoreModule } from '../../types.js';

/** Maximum accumulated output per task (100 KB). Older output is trimmed. */
const MAX_OUTPUT_BYTES = 100 * 1024;
/** Maximum number of finished (completed/failed) tasks retained in the map. */
const MAX_FINISHED_TASKS = 20;

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
   * Run a command in the background.
   * On Windows, uses PowerShell with UTF-8 encoding preamble matching agent-io.ts.
   * On Unix, uses the system shell directly.
   */
  async runCommand(cmd: string): Promise<number> {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(
            `try { chcp 65001 > $null } catch {}; $OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmd}`,
            'utf16le'
          ).toString('base64'),
        ], {
          cwd: this.core.getWorkDir(),
          windowsHide: true,
          detached: true,
        })
      : spawn(cmd, [], {
          cwd: this.core.getWorkDir(),
          shell: true,
          detached: true,
        });

    const pid = child.pid;
    if (pid === undefined) {
      // Spawn failed to produce a pid — throw so bg_create returns an error
      // instead of returning a fake (unkillable) pid.
      child.removeAllListeners();
      throw new Error(`Failed to spawn background process for command: ${cmd}`);
    }
    const task: BgTask = {
      pid,
      command: cmd,
      startTime: new Date(),
      status: 'running',
    };

    this.tasks.set(pid, task);
    this.processes.set(pid, child);

    // Trim finished tasks if we are retaining too many (Fix 4)
    this.trimFinishedTasks();

    // Handle output — accumulate silently, viewable via bg_print (Fix 3: cap at MAX_OUTPUT_BYTES)
    const appendOutput = (data: Buffer): void => {
      const text = data.toString();
      if (task.output) {
        task.output += text;
      } else {
        task.output = text;
      }
      // Cap accumulated output: keep the most recent bytes
      if (task.output.length > MAX_OUTPUT_BYTES) {
        task.output = task.output.slice(-MAX_OUTPUT_BYTES);
      }
    };

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    // Handle completion
    child.on('close', (code) => {
      // Only update if still running, to avoid overwriting an earlier 'error' status (race guard)
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
      }
    });

    child.on('error', (_err) => {
      task.status = 'failed';
    });

    return pid;
  }

  /**
   * Format background tasks for prompt.
   *
   * If pid is provided:
   *   - returns a detailed view of that task, including accumulated output (tail-capped)
   *   - if the task is not found, returns a not-found message
   * If pid is omitted:
   *   - returns a compact status list of all tasks, then trims finished ones (Fix 4)
   */
  async printBgTasks(pid?: number): Promise<string> {
    // Detailed view for a single task (Fix 1: expose output)
    if (pid !== undefined) {
      const task = this.tasks.get(pid);
      if (!task) {
        return `No background task with pid ${pid}.`;
      }
      const statusLabel = this.statusLabel(task.status);
      const lines = [
        `Background task ${pid}:`,
        `  status: ${statusLabel}`,
        `  command: ${task.command}`,
        `  started: ${task.startTime.toISOString()}`,
      ];
      if (task.output && task.output.length > 0) {
        // Show the most recent output (already capped at MAX_OUTPUT_BYTES)
        lines.push('  output (tail):', task.output);
      } else {
        lines.push('  output: (none)');
      }
      return lines.join('\n');
    }

    // Compact list of all tasks
    if (this.tasks.size === 0) {
      return 'No background tasks.';
    }

    const lines = ['Background tasks:'];
    for (const [taskPid, task] of this.tasks) {
      lines.push(`  ${this.statusLabel(task.status)} ${taskPid}: ${task.command}`);
    }

    // Trim finished tasks after listing so the map does not grow unbounded (Fix 4)
    this.trimFinishedTasks();

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
    const proc = this.processes.get(pid);
    if (proc) {
      try {
        const isWin = process.platform === 'win32';
        if (isWin) {
          // Windows: kill entire process tree
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
          // Unix: negative PID kills the entire process group
          process.kill(-pid, 'SIGKILL');
        }
      } catch (err) {
        // Fix 5: log kill failures instead of silently swallowing
        const msg = err instanceof Error ? err.message : String(err);
        this.core.brief('warn', 'bg', `Failed to kill pid ${pid}: ${msg}`);
      }
      this.processes.delete(pid);
    }

    const task = this.tasks.get(pid);
    if (task) {
      task.status = 'killed';
    }
  }

  /**
   * Get task by pid (for testing / bg_await)
   */
  getTask(pid: number): BgTask | undefined {
    return this.tasks.get(pid);
  }

  // --- helpers ---

  private statusLabel(status: BgTask['status']): string {
    const labels: Record<string, string> = {
      running: '[running]',
      completed: '[done]',
      failed: '[failed]',
      killed: '[killed]',
    };
    return labels[status] ?? '[?]';
  }

  /**
   * Trim finished (completed/failed) tasks from the map when the retained
   * count exceeds MAX_FINISHED_TASKS. Running tasks are never trimmed.
   * (Fix 4: prevent unbounded map growth)
   */
  private trimFinishedTasks(): void {
    const finishedPids: number[] = [];
    for (const [pid, task] of this.tasks) {
      if (task.status !== 'running') {
        finishedPids.push(pid);
      }
    }
    // finishedPids are in insertion order (oldest first); drop the oldest surplus
    const surplus = finishedPids.length - MAX_FINISHED_TASKS;
    if (surplus > 0) {
      for (let i = 0; i < surplus; i++) {
        const pidToRemove = finishedPids[i];
        this.tasks.delete(pidToRemove);
        this.processes.delete(pidToRemove);
      }
    }
  }
}