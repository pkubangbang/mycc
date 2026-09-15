/**
 * daemon-launch.ts - Spawn the daemon Lead and resolve its real PID
 *
 * Extracted from the Coordinator (src/index.ts) so `index.ts` stays a thin
 * orchestrator. The daemon launch chain differs by platform:
 *
 *   Windows (wrapper present):
 *     Coordinator → Go wrapper (bin/mycc-daemon.exe) → Lead (node + tsx)
 *     The wrapper is a one-shot launcher: it calls CreateProcessW, prints
 *     the Lead's real PID to stdout, and exits immediately. `child.pid` is
 *     therefore the WRAPPER's PID, not the Lead's — the wrapper's stdout
 *     must be read to obtain the Lead PID.
 *
 *   Unix / fallback (no wrapper):
 *     Coordinator → Lead (node/tsx runs lead.ts directly)
 *     `child.pid` IS the Lead's real PID — no stdout parsing needed.
 *
 * {@link spawnDaemonLead} unifies both paths and resolves to the Lead's real
 * PID (or an error string if the spawn failed), so the caller can simply
 * print the PID and exit.
 */

import { ChildProcess, spawn } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { getProjectRoot, spawnTsx, getTsxLoaderPath } from './tsx-run.js';
import { isVerbose } from '../config.js';

const PROJECT_ROOT = getProjectRoot();

/** Result of spawning the daemon Lead. */
export interface DaemonSpawnResult {
  /** The Lead's real PID (resolved from the wrapper's stdout on Windows). */
  pid: number | null;
  /**
   * The spawned child process. The caller needs this for the verbose grace
   * window (listening for the child's 'exit' event before the Coordinator
   * exits). It is already `unref()`-ed, so keeping the handle does NOT
   * prevent the Coordinator from exiting.
   */
  child: ChildProcess;
  /**
   * Non-fatal warning if the PID could not be determined (e.g. the wrapper
   * failed to spawn the Lead). When set, `pid` falls back to the child's
   * PID and the caller should surface this to the user.
   */
  warning?: string;
  /**
   * Fatal error if the daemon could not be spawned at all (e.g. the wrapper
   * binary couldn't be launched). When set, `pid` is null and the caller
   * should exit non-zero.
   */
  error?: string;
}

/**
 * Spawn the daemon Lead as a detached background process and resolve its
 * real PID.
 *
 * On the wrapper path (Windows + `bin/mycc-daemon.exe`), this waits for the
 * one-shot wrapper to exit (it exits in milliseconds) and parses the Lead
 * PID from its stdout. On the fallback path, `child.pid` is already the
 * Lead PID and the function resolves immediately.
 *
 * Verbose-mode diagnostics (lifecycle event logging) are attached to the
 * spawned child so the Coordinator log captures early exit/error/IPC events
 * in the brief window before the Coordinator exits. The durable record is
 * the Lead's own `verbose-lead-<ts>.log`.
 *
 * The child is `unref()`-ed so the Coordinator can exit without waiting for
 * it — the daemon survives because it is detached into its own process
 * group / console.
 *
 * @param forwardedArgs - CLI args to forward (already include --daemon etc.)
 * @param env - environment for the spawned child
 * @returns the Lead's real PID, or an error/warning if spawning failed
 */
export function spawnDaemonLead(
  forwardedArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<DaemonSpawnResult> {
  const tsxScript = resolve(PROJECT_ROOT, 'src', 'lead.ts');

  // ── Decide wrapper vs fallback ──
  //
  // The Go wrapper gives the Lead a HIDDEN console on Windows, eliminating
  // the cmd.exe window flashing that occurs when a detached Lead (no
  // console) spawns cmd.exe which self-allocates a visible console. See
  // src/native/daemon-wrapper/main.go and docs/lead-detach-issue-solution.md.
  //
  // Fallback: when the wrapper binary is missing (built from source without
  // Go, or on a non-Windows platform), spawn the Lead directly via tsx.
  // Unix uses process groups, not consoles, so the flash issue doesn't apply.
  const wrapperPath = resolve(PROJECT_ROOT, 'bin', 'mycc-daemon.exe');
  const useWrapper = process.platform === 'win32' && existsSync(wrapperPath);

  let child: ChildProcess;
  if (useWrapper) {
    const loaderPath = getTsxLoaderPath();
    child = spawn(wrapperPath, [
      process.execPath,           // node.exe path
      loaderPath,                 // tsx ESM loader (file:// URL)
      tsxScript,                  // src/lead.ts
      ...forwardedArgs,           // --daemon, --skip-healthcheck, etc.
    ], {
      cwd: process.cwd(),
      // stdio: no IPC channel — the Go wrapper can't do Node.js IPC, and the
      // daemon Lead's IPC is fire-and-forget anyway (Coordinator exits
      // immediately). The Lead's IPC guard is relaxed for daemon mode
      // (agent-repl.ts) so it boots without process.send.
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      // detached: true so the wrapper survives the Coordinator's exit.
      detached: true,
    });
  } else {
    child = spawnTsx({
      script: tsxScript,
      args: forwardedArgs,
      cwd: process.cwd(),
      // IPC kept so the Lead's process.send guard passes; messages are
      // fire-and-forget (the Coordinator exits right after).
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env,
      // Detach into its own process group so the daemon survives the
      // Coordinator's exit. Without this, Windows sends CTRL_CLOSE_EVENT
      // to the whole console group on Coordinator exit, killing the Lead.
      detached: true,
    });
  }

  // Verbose-mode diagnostics: log daemon lifecycle events to the coordinator
  // log. These fire asynchronously; since the Coordinator exits right after
  // this, only events arriving in the brief window before exit are captured.
  // The durable record is the Lead's own verbose-lead-<ts>.log.
  if (isVerbose()) {
    console.log(`[verbose] spawning daemon lead: script=${tsxScript} args=${JSON.stringify(forwardedArgs)} pid=${child.pid}`);
    child.on('exit', (code, signal) => {
      console.log(`[verbose] daemon lead exited: code=${code} signal=${signal}`);
    });
    child.on('error', (err) => {
      console.log(`[verbose] daemon lead error: ${err.stack || err.message}`);
    });
    child.on('message', (msg) => {
      console.log(`[verbose] daemon lead IPC: ${JSON.stringify(msg)}`);
    });
  }

  // Detach so the daemon survives the Coordinator's exit.
  child.unref();

  if (useWrapper) {
    return resolveWrapperLeadPid(child);
  }
  // Fallback path: child IS the Lead — child.pid is already correct.
  return Promise.resolve({ pid: child.pid ?? null, child });
}

/**
 * Resolve the Lead's real PID from the one-shot Go wrapper's stdout.
 *
 * The wrapper prints the Lead PID (`pi.dwProcessID` from CreateProcessW)
 * to stdout then exits immediately. We buffer stdout, wait for the
 * wrapper's exit (guarantees the full line is flushed), and parse it.
 *
 * The wrapper's stderr is forwarded to the terminal so CreateProcessW
 * failures (e.g. "mycc-daemon: CreateProcessW failed: ...") are visible.
 * A spawn-error handler rejects so the caller can exit non-zero instead of
 * hanging for an 'exit' event that will never fire.
 */
function resolveWrapperLeadPid(child: ChildProcess): Promise<DaemonSpawnResult> {
  return new Promise<DaemonSpawnResult>((resolveP) => {
    let wrapperStdout = '';
    let settled = false;

    const finish = (result: DaemonSpawnResult) => {
      if (settled) return;
      settled = true;
      resolveP(result);
    };

    // Buffer the wrapper's stdout to capture the Lead's real PID.
    child.stdout?.on('data', (chunk: Buffer) => {
      wrapperStdout += chunk.toString();
    });

    // Forward wrapper stderr to the terminal so CreateProcessW failures are
    // visible.
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // The wrapper is one-shot: CreateProcessW → print PID → exit. Wait for
    // its exit to guarantee stdout is flushed, then parse the Lead PID.
    child.on('exit', (wrapperCode) => {
      const leadPid = parseInt(wrapperStdout.trim(), 10);
      if (!Number.isNaN(leadPid)) {
        if (wrapperCode !== 0 && wrapperCode !== null) {
          finish({
            pid: leadPid,
            child,
            warning: `wrapper exited with code ${wrapperCode}, but the Lead was spawned (pid: ${leadPid}).`,
          });
        } else {
          finish({ pid: leadPid, child });
        }
      } else {
        // Wrapper printed no parseable PID — CreateProcessW likely failed
        // (the wrapper prints an error to stderr in that case, forwarded
        // above). Surface a warning; the caller falls back to child.pid.
        finish({
          pid: child.pid ?? null,
          child,
          warning: `could not determine lead PID from wrapper output. The wrapper may have failed.`,
        });
      }
    });

    // Handle spawn errors (e.g. wrapper binary unreadable) — these fire
    // before 'exit', so without this the promise would hang.
    child.on('error', (err) => {
      finish({ pid: null, child, error: `Daemon wrapper error: ${err.message}` });
    });
  });
}

/**
 * Exit the Coordinator after stdout has drained, so any preceding
 * console.log / process.stdout.write (e.g. the "Daemon started" PID line)
 * is actually flushed before the process terminates.
 *
 * `process.exit()` can cut off asynchronous stdout writes before they reach
 * a non-TTY destination (pipe, redirect, file) — the buffer is discarded on
 * exit. Writing with a drain callback and exiting only once it fires (or
 * after a 1 s safety timeout) guarantees the output is visible in every
 * context (TTY, pipe, redirect). The timeout prevents a hang if the drain
 * callback never fires (e.g. a closed/errored stream).
 */
export function drainedExit(code = 0): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  // Safety timeout: never hang waiting for a drain that won't come.
  const safety = setTimeout(finish, 1000);
  if (safety.unref) safety.unref();
  // process.stdout.write returns true if the data was flushed synchronously
  // (TTY / empty buffer) — in that case there is nothing to wait for, exit
  // immediately. A false return means it's buffered; the callback fires on
  // drain.
  const flushed = process.stdout.write('', finish);
  if (flushed) finish();
}

/**
 * Hold the Coordinator alive briefly (verbose mode) so the daemon's early
 * lifecycle events (exit/error/ready IPC) are captured in the coordinator
 * log before exit. Then exit via {@link drainedExit}.
 *
 * If the daemon exits within the grace window (the silent-exit bug), the
 * verbose 'exit' listener logs the code. Otherwise we exit after the grace
 * period and let the daemon run on. The durable record is the Lead's own
 * verbose-lead-<ts>.log.
 *
 * In non-verbose mode this exits immediately (via drainedExit).
 *
 * @param child - the spawned daemon child (wrapper or Lead)
 */
export function finishDaemonExit(child: ChildProcess): void {
  if (isVerbose()) {
    let exited = false;
    child.on('exit', () => { exited = true; });
    const graceMs = 2000;
    setTimeout(() => {
      if (!exited) {
        console.log(`[verbose] daemon still alive after ${graceMs}ms — coordinator exiting, daemon continues (pid=${child.pid})`);
      } else {
        console.log(`[verbose] daemon exited within grace window — see verbose-lead-<ts>.log for the reason`);
      }
      drainedExit();
    }, graceMs).unref?.();
    return;
  }

  drainedExit();
}