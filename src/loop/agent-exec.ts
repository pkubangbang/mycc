/**
 * agent-exec.ts - Subprocess execution for the bash tool
 *
 * Extracted from agent-io.ts. Contains the pure subprocess-execution concern:
 * the CLIXML noise filter, the output ReplayBuffer, the ExecOptions/ExecResult
 * types, and runExec() — the spawn + timeout + process-kill logic that exec()
 * delegates to. The shell is selected once at startup (shell-detect.ts); this
 * module consumes that decision via getShellInfo() and commits to it (no
 * runtime fallback — see the windows-shell-strategy skill).
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { getShellInfo } from '../utils/shell-detect.js';

/**
 * Options for exec command
 */
export interface ExecOptions {
  cwd: string;
  command: string;
  timeout: number;
}

/**
 * Result of exec command
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Filter PowerShell CLIXML noise from a stderr chunk.
 *
 * When PowerShell runs non-interactively without a TTY (exactly the spawn
 * pattern used here: `-NonInteractive -EncodedCommand`), it serializes its
 * progress / warning / error records as CLIXML on stderr. The output starts
 * with a `#< CLIXML` marker followed by `<Objs ...>...</Objs>` XML blocks.
 * This is by-design per PowerShell#16678 (closed "won't fix").
 *
 * $ProgressPreference='SilentlyContinue' (set in the command preamble)
 * suppresses the progress records at the source, but other records (e.g.
 * module-loading warnings) can still slip through as CLIXML. This filter
 * strips any `#< CLIXML\n<Objs ...>...</Objs>` block from the chunk so the
 * tool result stays clean. Real stderr text outside CLIXML blocks is kept.
 *
 * Pattern adapted from open-science PR#421 and midscene PR#2756.
 */
function filterCliXml(chunk: Buffer): Buffer {
  const text = chunk.toString('utf-8');
  // Fast path: no CLIXML marker → return untouched.
  if (!text.includes('#< CLIXML') && !text.includes('<Objs')) {
    return chunk;
  }
  // Strip a `#< CLIXML` prefix (may appear at the very start of the stream)
  // and any `<Objs ...>...</Objs>` blocks (greedy across the whole chunk).
  const cleaned = text
    .replace(/#<\s*CLIXML\s*\r?\n?/g, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .replace(/<Objs[^>]*>[\s\S]*$/g, ''); // unterminated trailing <Objs fragment
  return Buffer.from(cleaned, 'utf-8');
}

/**
 * ReplayBuffer - Buffer for collecting stdout/stderr bytes
 * Supports both string and base64 output formats.
 */
class ReplayBuffer {
  private chunks: Buffer[] = [];

  /** Write bytes into buffer */
  write(data: Buffer | string): void {
    if (typeof data === 'string') {
      this.chunks.push(Buffer.from(data));
    } else {
      this.chunks.push(data);
    }
  }

  /** Get content as string (for ctx.core.brief()) */
  getString(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }

  /** Get content as base64 (for IPC transmission) */
  getBase64(): string {
    return Buffer.concat(this.chunks).toString('base64');
  }
}

/** The 5.1-only Layer-2 patch (default write encoding -> no-BOM UTF-8). */
const PS51_LAYER2_PATCH =
  "$PSDefaultParameterValues['Set-Content:Encoding']=[System.Text.UTF8Encoding]::new($false); " +
  "$PSDefaultParameterValues['Add-Content:Encoding']=[System.Text.UTF8Encoding]::new($false); " +
  "$PSDefaultParameterValues['Out-File:Encoding']=[System.Text.UTF8Encoding]::new($false); ";

/**
 * Build the command string + spawn the process for the detected shell.
 * Exhaustive per-shell branches — no catch-all default; an unknown ShellKind
 * throws so a new shell added without an exec branch fails loudly.
 *
 * @param cwd - working directory for the subprocess
 * @param command - the raw command string from the LLM
 * @returns the spawned ChildProcess and whether this is a Windows shell
 *   (Windows uses taskkill /T for tree kill; Unix uses negative-PID group kill).
 */
function spawnForShell(cwd: string, command: string): { proc: ChildProcess; isWin: boolean } {
  const shellInfo = getShellInfo();

  if (shellInfo.shell === 'pwsh7') {
    const effectiveCommand = `try { chcp 65001 > $null } catch {}; $ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
    return {
      // Native exes (e.g. python) bypass the PowerShell preamble's UTF-8
      // settings and use the system active code page (936=GBK) for their
      // stdout/stderr pipes, producing mojibake when mycc decodes as UTF-8.
      // PYTHONUTF8=1 forces Python's UTF-8 mode (3.7+, also fixes -c arg
      // decoding); PYTHONIOENCODING=utf-8 forces stdio encoding for older
      // interpreters. Mirrors the bg.ts fix (commit e492e35).
      proc: spawn(shellInfo.path!, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(effectiveCommand, 'utf16le').toString('base64'),
      ], { cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }),
      isWin: true,
    };
  }

  if (shellInfo.shell === 'powershell5') {
    // 5.1 defaults to ANSI read / BOM-on-UTF8 write — append the
    // $PSDefaultParameterValues Layer-2 patch (default write encoding ->
    // no-BOM UTF-8). An explicit -Encoding UTF8 from the LLM still wins and
    // still writes a BOM; Get-Content's read default is unfixable in 5.1
    // (left to the system-prompt reminder). See windows-shell-strategy skill.
    const effectiveCommand = `try { chcp 65001 > $null } catch {}; $ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${PS51_LAYER2_PATCH}${command}`;
    return {
      // Native exes bypass the preamble's UTF-8 settings (see pwsh7 branch
      // comment). PYTHONUTF8/PYTHONIOENCODING force UTF-8 stdio for Python
      // and other native exes that respect these vars.
      proc: spawn(shellInfo.path!, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(effectiveCommand, 'utf16le').toString('base64'),
      ], { cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }),
      isWin: true,
    };
  }

  if (shellInfo.shell === 'bash' || shellInfo.shell === 'zsh') {
    return {
      proc: spawn('bash', ['-c', command], { cwd, detached: true }),
      isWin: false,
    };
  }

  throw new Error(`exec: unsupported shell kind '${shellInfo.shell as string}'`);
}

/**
 * Kill the entire process tree for a timed-out subprocess. Windows uses
 * `taskkill /F /T /PID`; Unix uses negative-PID group kill (bash is the group
 * leader because of detached:true).
 */
function killProcessTree(pid: number, isWin: boolean): void {
  if (isWin) {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGKILL');
  }
}

/**
 * Execute a command in a subprocess with a timeout, returning the captured
 * stdout/stderr, exit code, and timeout/interrupt flags. The shell is chosen
 * by the startup detection (shell-detect.ts) — this function does not fall
 * back or re-resolve.
 *
 * @param options - cwd, command, timeout (1-60s)
 * @param onNeglected - register an ESC callback that resolves the wait early
 *   with the partial output collected so far (the subprocess keeps running).
 * @returns the ExecResult once the subprocess exits, times out, or is
 *   interrupted by ESC.
 */
export function runExec(
  options: ExecOptions,
  onNeglected: (cb: () => void) => void,
): Promise<ExecResult> {
  const { cwd, command, timeout } = options;

  // 1. Validate timeout: must be a positive integer between 1 and 60.
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
    throw new Error(`timeout must be an integer between 1 and 60, got: ${timeout}`);
  }
  const timeoutMs = timeout * 1000;

  // 2. Create stdout/stderr buffers.
  const stdoutBuffer = new ReplayBuffer();
  const stderrBuffer = new ReplayBuffer();

  // 3. Create subprocess with the startup-detected shell.
  const { proc, isWin } = spawnForShell(cwd, command);

  // Collect stdout and stderr.
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer.write(chunk);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer.write(filterCliXml(chunk));
  });

  // 4. Set up timer and race with subprocess.
  return new Promise((resolve) => {
    let completed = false;

    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        try {
          if (proc.pid) {
            killProcessTree(proc.pid, isWin);
          }
        } catch {
          // Process may have already exited — ignore
        }
        resolve({
          stdout: '',
          stderr: '',
          interrupted: false,
          exitCode: 137,
          timedOut: true,
        });
      }
    }, timeoutMs);

    // Register callback for ESC (neglected) - skip subprocess wait.
    onNeglected(() => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        // Return premature output, let subprocess continue in background.
        resolve({
          stdout: stdoutBuffer.getString(),
          stderr: stderrBuffer.getString(),
          interrupted: true,
          exitCode: -1, // Unknown - subprocess still running
          timedOut: false,
        });
      }
    });

    // Handle subprocess completion.
    proc.on('close', (code) => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        resolve({
          stdout: stdoutBuffer.getString(),
          stderr: stderrBuffer.getString(),
          interrupted: false,
          exitCode: code ?? 1,
          timedOut: false,
        });
      }
    });

    // Handle spawn errors.
    proc.on('error', (err) => {
      if (!completed) {
        completed = true;
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: err.message,
          interrupted: false,
          exitCode: 1,
          timedOut: false,
        });
      }
    });
  });
}