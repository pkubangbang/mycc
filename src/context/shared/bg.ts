/**
 * bg.ts - Background tasks module: run bash commands in background
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import type { BgModule, BgTask, BgWaitResult, CoreModule } from '../../types.js';
import { getShellInfo } from '../../utils/shell-detect.js';
import { filterCliXml, PS51_LAYER2_PATCH } from '../../loop/agent-exec.js';
import { agentIO } from '../../loop/agent-io.js';
import { getServeHub } from '../../serve/serve-registry.js';

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
   * On Windows, uses the detected shell (pwsh7 or powershell5) with the same
   * UTF-8 encoding preamble as the bash tool (agent-exec.ts): chcp 65001 +
   * $OutputEncoding/[Console]::OutputEncoding UTF-8, plus the 5.1-only
   * $PSDefaultParameterValues Layer-2 patch (no-BOM write + UTF-8 read).
   * On Unix, uses the system shell directly.
   */
  async runCommand(cmd: string): Promise<number> {
    const shellInfo = getShellInfo();
    const isWin = shellInfo.isWin;

    // Build the Windows preamble. pwsh7 defaults to UTF-8 no-BOM, so it only
    // needs the console/pipe encoding preamble; powershell5 additionally needs
    // the Layer-2 patch (no-BOM write default + UTF-8 read default).
    const preamble = `try { chcp 65001 > $null } catch {}; $ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${shellInfo.shell === 'powershell5' ? PS51_LAYER2_PATCH : ''}`;

    const child = isWin
      ? spawn(shellInfo.path ?? 'powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(`${preamble}${cmd}`, 'utf16le').toString('base64'),
        ], {
          cwd: this.core.getWorkDir(),
          windowsHide: true,
          // NOTE: detached:true on Windows creates a new console window,
          // which breaks stdout/stderr piping (output goes to that console
          // instead of the pipes). We use unref() instead to allow the
          // child to outlive the parent while keeping pipes intact.
          // PYTHONUTF8/PYTHONIOENCODING force Python scripts to use UTF-8
          // for their stdout/stderr pipes regardless of the system code page
          // (mirrors agent-exec.ts).
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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

    // Allow parent to exit without killing the child process.
    // On Windows, this replaces detached:true (which breaks pipes).
    // On Linux, this is needed because detached:true still keeps the
    // parent's event loop waiting for the child without unref().
    child.unref();

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
      const text = data.toString('utf-8');
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
    child.stderr?.on('data', (data: Buffer) => appendOutput(filterCliXml(data)));

    // Handle completion.
    //
    // Two events matter and they are NOT the same:
    //   - 'exit'  fires when the child PROCESS exits.
    //   - 'close' fires only once ALL stdio streams are closed.
    //
    // On Windows the child is `powershell -EncodedCommand`; if the command
    // spawns a grandchild that inherits the stdio pipes (very common — e.g.
    // `pnpm test` → vitest → worker processes), those pipes stay open after
    // the direct child exits, so 'close' is deferred until the grandchild
    // exits — or NEVER, if it lingers/detaches. Keying completion off 'close'
    // alone therefore leaves the task stuck at status='running' forever and
    // bg_await polls until timeout (observed: exit at 295ms, close at 8631ms
    // under a `Start-Sleep 8` grandchild).
    //
    // So the running→finished TRANSITION is driven by 'exit' (the command is
    // done), while 'close' remains to capture any trailing output and to set
    // the final code. Both honor the guard so a late 'close' can never
    // resurrect a finished task back to 'running', nor overwrite a 'killed'
    // status set by killTask().
    child.on('exit', (code) => {
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
      }
    });

    child.on('close', (code) => {
      // Finalize: 'close' is authoritative for the exit code and may arrive
      // after any trailing stdout. Only update if still running (a race guard
      // so a late 'close' doesn't overwrite an 'error'/'killed' status).
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
      }
    });

    child.on('error', (_err) => {
      // Only set failed if not already finalized (close may have already set completed/failed)
      if (task.status === 'running') {
        task.status = 'failed';
      }
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
   * Kill every still-running background task.
   *
   * Called from the shutdown signal handlers (SIGINT/SIGTERM) so that bg
   * tasks — which are spawned with unref() and otherwise outlive the parent
   * — are tree-killed before the Lead exits. Without this, any bg task that
   * is still 'running' when mycc quits becomes an orphan process holding its
   * PID indefinitely (the historical PID-consumption leak: the teardown
   * sequence dismissed the team and stopped the peer, but never touched bg).
   *
   * Best-effort: a kill failure is logged via brief() (inside killTask) but
   * does not abort the remaining kills or the caller's teardown. Reuses
   * killTask() so the cross-platform tree-kill (taskkill /F /T on Windows,
   * kill -PG on Unix) stays in one place.
   */
  async killAllRunning(): Promise<void> {
    // Snapshot the running pids first — killTask() mutates this.tasks /
    // this.processes, so iterating the live map while killing would skip
    // entries or throw on a concurrently-deleted key.
    const runningPids: number[] = [];
    for (const [pid, task] of this.tasks) {
      if (task.status === 'running') {
        runningPids.push(pid);
      }
    }
    for (const pid of runningPids) {
      await this.killTask(pid);
    }
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

  /**
   * Block until the target task(s) finish, the wait times out, ESC is pressed,
   * or a WebUI steering note is queued.
   *
   * This is the bg module's unified wait primitive — the analogue of
   * TeamManager.awaitTeammates. The bg module OWNS the background-task resource,
   * so it also owns the wait loop AND the ESC/steering watch; the `bg_await`
   * tool is a thin wrapper and never imports the serve layer. That keeps the
   * tool decoupled from getServeHub() (see the decoupled-ipc-bounceback lesson:
   * a listener/watch belongs in the module that owns the resource, never in the
   * tool/I-O layer).
   *
   * ESC: registers agentIO.onNeglected (main process only; the child never
   * receives IPC neglection, so the callback simply never fires there and the
   * timeout still governs). Steering: PEEKS the WebUI queue (non-consuming) so
   * the single consumption point remains COLLECT's 2c drain — mirrors
   * awaitTeammates.
   */
  async waitForTasks(opts?: { pid?: number; timeoutMs?: number }): Promise<BgWaitResult> {
    const pid = opts?.pid;
    const timeoutMs = opts?.timeoutMs ?? 60000;
    const pollInterval = 1000;

    const startTime = Date.now();
    let interrupted = false;
    let steered = false;

    // ESC handler — only meaningful in the main process (the child has no IPC
    // neglection); registered regardless for parity, the timeout still governs.
    let unsubscribe: (() => void) | undefined;
    if (agentIO.isMainProcess()) {
      unsubscribe = agentIO.onNeglected(() => { interrupted = true; });
    }

    try {
      while (!interrupted && !steered) {
        // WebUI steering note queued by the user (mid-task direction). PEEK
        // only (non-consuming) — the drain stays downstream in COLLECT's 2c
        // block, keeping a single consumption point. Guarded by isRunning() so
        // a non-serve session (no WebUI) never blocks.
        if (getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0) {
          steered = true;
          break;
        }

        if (pid !== undefined) {
          // Waiting for a specific pid: check just that task (no full scan).
          const task = this.getTask(pid);
          if (!task || task.status !== 'running') {
            return {
              reason: 'completed',
              pid,
              status: task?.status ?? 'completed',
              output: task?.output,
            };
          }
        } else {
          // Waiting for ALL tasks: done once none are still running.
          if (!(await this.hasRunningBgTasks())) {
            return { reason: 'completed' };
          }
        }

        if (Date.now() - startTime >= timeoutMs) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    } finally {
      // Clean up: remove the ESC handler if still registered.
      if (unsubscribe) {
        unsubscribe();
      }
    }

    if (interrupted) {
      return { reason: 'esc' };
    }

    if (steered) {
      // Return the peeked notes WITHOUT consuming them (COLLECT drains next).
      return { reason: 'steering', notes: getServeHub().getSteeringNotes() };
    }

    return { reason: 'timeout', pid };
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