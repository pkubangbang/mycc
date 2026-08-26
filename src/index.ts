/**
 * index.ts - Main entry point (Coordinator)
 *
 * The Coordinator process manages the Lead agent:
 * - Loads environment and validates config
 * - Spawns and manages the Lead process
 * - Forwards I/O between terminal and Lead
 * - Handles directory-change restarts via IPC
 *
 * Architecture:
 *   Terminal → Coordinator (this file) → Lead → Teammates
 *
 * Input flow:
 * - Coordinator runs in raw mode, forwards all bytes to Lead
 * - Lead uses LineEditor for proper wrapped line handling
 * - Coordinator only intercepts coordinator-level commands (Ctrl+C, Ctrl+D, ESC)
 */

import { ChildProcess, spawn } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { isVerbose, validateEnv, ensureToolTypeImports, shouldRunSetup, loadEnv, shouldServe, shouldDaemon } from './config.js';
import { agentIO } from './loop/agent-io.js';
import { parseKeys, isCtrlC, isEscape } from './utils/key-parser.js';
import { getProjectRoot, spawnTsx, getTsxLoaderPath } from './utils/tsx-run.js';
import { printHelp } from './help.js';
import { installVerboseLog } from './utils/verbose-log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = getProjectRoot();

// ---------------------------------------------------------------------------
// Help / Version (handled before anything else, no side effects)
// ---------------------------------------------------------------------------

// --help / -h: print usage and exit 0 (before setting process title, raw mode,
// or spawning any child). Minimist would also pick these up, but we intercept
// them here to avoid the cost of loading config / spawning the lead process.
if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  printHelp();
  process.exit(0);
}

// Set process title so it shows as 'mycc' in process list (ps, top, etc.)
process.title = 'mycc';

// Set terminal window title to 'mycc' (works in most terminal emulators)
// ANSI escape sequence: ESC ] 0 ; <title> BEL
if (process.stdout.isTTY) {
  process.stdout.write('\x1b]0;mycc\x07');
}

// Parsed upfront so it's available to all functions, including the daemon
// early-return path (startDaemonLead) that runs before runCoordinator()'s
// nested state declarations. Previously startDaemonLead worked around the
// temporal dead zone with a redundant `skipHealthCheckLocal` re-derivation;
// hoisting the const here makes that unnecessary.
const skipHealthCheck = process.argv.includes('--skip-healthcheck');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** IPC message from Lead to Coordinator */
type CoordinatorMessage =
  | { type: 'ready' }
  | { type: 'restart'; sessionId: string; cwd: string }
  | { type: 'reload'; serveActive: boolean; servePort: number; serveHost: string | null }
  | { type: 'exit' }
  | { type: 'serve_mode'; active: boolean }
  | { type: 'serve_shutdown_done' }
  | { type: 'skill_reindex' };

// ---------------------------------------------------------------------------
// Setup Mode
// ---------------------------------------------------------------------------

if (shouldRunSetup()) {
  // Run setup wizard and exit
  const setupScript = resolve(PROJECT_ROOT, 'src', 'setup', 'index.ts');
  const setupProcess = spawnTsx({ script: setupScript, stdio: 'inherit' });
  setupProcess.on('exit', (code) => process.exit(code ?? 0));
} else {
  // Run normal coordinator
  runCoordinator();
}

// ---------------------------------------------------------------------------
// Coordinator Implementation
// ---------------------------------------------------------------------------

function runCoordinator(): void {
  // ---------------------------------------------------------------------------
  // Environment Setup
  // ---------------------------------------------------------------------------

  loadEnv();

  // Validate environment before proceeding
  const envResult = validateEnv();
  envResult.warnings.forEach(w => agentIO.brief('warn', 'config', w.instruction));

  if (!envResult.valid) {
    envResult.missing.forEach(m => agentIO.brief('error', 'config', m.instruction));
    agentIO.log(chalk.yellow('\nRun \'mycc --setup\' to configure your environment.'));
    process.exit(2);  // Exit code 2 = setup required
  }

  if (isVerbose()) {
    agentIO.verbose('config', 'Debug logging enabled');
    const logPath = installVerboseLog('coordinator');
    if (logPath) {
      console.log(chalk.gray(`[verbose] coordinator log → ${logPath}`));
    }
  }

  // Ensure type imports work for custom tools
  ensureToolTypeImports();

  // ── --daemon: detach and exit immediately ──
  // When --daemon is set, the Coordinator spawns the Lead as a detached
  // background process (no terminal I/O, no stdin forwarding, no resize
  // polling) and exits immediately. The Lead runs headless in auto mode.
  // This skips the entire terminal setup below.
  if (shouldDaemon()) {
    startDaemonLead();
    return;
  }

  // ---------------------------------------------------------------------------
  // Coordinator State
  // ---------------------------------------------------------------------------

  let lead: ChildProcess | null = null;
  let isRestarting = false;

  // Serve mode: when active, Coordinator filters stdin (only ESC and Ctrl+C
  // are forwarded). Set via IPC from Lead (/serve command) or directly from
  // the --serve CLI flag at startup.
  let serveMode = shouldServe();

  // Graceful serve-shutdown state (Ctrl+C while serve is active).
  // The Coordinator sends a 'serve_shutdown' IPC and waits up to 3 s for
  // 'serve_shutdown_done' before force-killing the Lead — this gives the
  // Lead time to close the Vite dev server and HTTP port cleanly instead of
  // orphaning them on Windows (where lead.kill() → TerminateProcess, no
  // signal handler runs).
  let shuttingDownServe = false;
  let serveShutdownTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // Lead Process Management
  // ---------------------------------------------------------------------------

  function startLead(args: string[] = [], cwd = process.cwd()): ChildProcess {
    const tsxScript = resolve(PROJECT_ROOT, 'src', 'lead.ts');

    // Forward skip-healthcheck flag if set
    const forwardedArgs = skipHealthCheck
      ? [...args, '--skip-healthcheck']
      : args;

    // Pass terminal columns to Lead process for proper line wrapping
    const env = { ...process.env };
    // Use COLUMNS env var if set, otherwise use process.stdout.columns
    env.COLUMNS = process.env.COLUMNS || String(process.stdout.columns || 80);
    // Pass the coordinator's PID so the lead agent can avoid killing its parent
    // process when stopping dev servers or running broad kill operations.
    env.MYCC_COORDINATOR_PID = String(process.pid);

    const child = spawnTsx({
      script: tsxScript,
      args: forwardedArgs,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env,
    });

    // Handle stdout - forward directly
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
    });

    // Handle stderr - forward directly
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Note: stdin is NOT piped here. Raw input is forwarded via the
    // 'data' handler in Terminal Setup section, which intercepts
    // coordinator-level commands and forwards the rest to Lead.

    // Handle IPC
    child.on('message', (msg: CoordinatorMessage) => {
      if (msg.type === 'restart') {
        restart(msg.sessionId, msg.cwd);
      } else if (msg.type === 'reload') {
        // /reload — restart only the lead with fresh code (no --from, so no
        // context pre-population). The coordinator is reused; teammates die
        // with the old lead. If serve was active, forward --serve/--host so
        // the new lead rebinds the web UI to the same port (browser
        // auto-reconnects after the brief disconnect).
        reloadLead(msg.serveActive, msg.servePort, msg.serveHost);
      } else if (msg.type === 'exit') {
        // Lead requested exit - exit coordinator cleanly with code 0
        process.exit(0);
      } else if (msg.type === 'serve_mode') {
        // Lead toggled serve mode — update stdin filter accordingly
        serveMode = msg.active;
      } else if (msg.type === 'serve_shutdown_done') {
        // Lead finished shutting down Vite after our 'serve_shutdown' IPC.
        // Now it's safe to kill the Lead — the port is released.
        if (shuttingDownServe) {
          if (serveShutdownTimer) { clearTimeout(serveShutdownTimer); serveShutdownTimer = null; }
          shuttingDownServe = false;
          serveMode = false;
          forceKillLead();
          cleanup();
          process.exit(130);
        }
      } else if (msg.type === 'skill_reindex') {
        // Loader's skill file watcher detected a project-skill change and
        // wants the wiki 'skills' domain re-indexed. Relay the signal back
        // to the Lead so ParentContext (the wiki module's owner) can act on
        // it — the loader stays decoupled from the wiki module. Pure echo,
        // no state.
        child.send({ type: 'skill_reindex' });
      }
    });

    // Handle exit - cleanup and exit coordinator
    child.on('exit', (code) => {
      // Only exit coordinator if this is the current lead and we're not restarting
      if (child === lead && !isRestarting) {
        // Cleanup
        child.stdin?.destroy();
        process.exit(code ?? 0);
      }
    });

    child.on('error', (err) => {
      console.error('Lead process error:', err);
      process.exit(1);
    });

    return child;
  }

  async function restart(sessionId: string, cwd: string): Promise<void> {
    isRestarting = true;
    const previousLead = lead;

    // Serve mode does not survive restart — a new Lead process starts
    // fresh (ServeHub is a Lead-process singleton, closed on process exit).
    const wasServeActive = serveMode;
    serveMode = false;

    // Kill old Lead. When serve is active, ask the Lead to shut down Vite
    // via IPC before SIGTERM so the next Lead won't hit EADDRINUSE on
    // /serve. This is critical on Windows where lead.kill('SIGTERM') calls
    // TerminateProcess — the SIGTERM handler never runs.
    if (previousLead) {
      if (wasServeActive) {
        // Graceful: ask Lead to shut down serve, wait up to 1.5 s
        let shutdownDone = false;
        const onShutdownDone = (msg: CoordinatorMessage) => {
          if (msg.type === 'serve_shutdown_done') shutdownDone = true;
        };
        previousLead.on('message', onShutdownDone);
        previousLead.send({ type: 'serve_shutdown' });
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(() => resolve(), 1500);
          const check = setInterval(() => {
            if (shutdownDone || previousLead.killed) {
              clearTimeout(deadline);
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
        previousLead.off('message', onShutdownDone);
      }
      previousLead.kill('SIGTERM');
      previousLead.unref();
    }

    // Start new Lead (stdin forwarding continues automatically via data handler)
    const currentLead = startLead(['--from', sessionId], cwd);
    lead = currentLead;

    // Wait for ready signal. If the new Lead exits before sending 'ready',
    // exit the Coordinator instead of hanging forever.
    let settled = false;
    await new Promise<void>((resolve) => {
      const onReady = (msg: CoordinatorMessage) => {
        if (msg.type === 'ready' && !settled) {
          settled = true;
          currentLead.off('message', onReady);
          currentLead.off('exit', onFail);
          resolve();
        }
      };
      const onFail = (_code: number | null) => {
        if (!settled) {
          settled = true;
          currentLead.off('message', onReady);
          console.error(chalk.red('New lead process exited unexpectedly during restart.'));
          process.exit(1);
        }
      };
      currentLead.on('message', onReady);
      currentLead.on('exit', onFail);
    });

    isRestarting = false;
  }

  /**
   * /reload — restart only the Lead process, reusing the Coordinator.
   *
   * Differs from {@link restart} (used by /load) in two ways:
   *   1. No `--from` flag is passed → the new Lead calls createNewSession(),
   *      producing a fresh empty triologue. No context is pre-populated (the
   *      conversation is cleared).
   *   2. Serve mode survives — if the old Lead had /serve active, the new
   *      Lead is spawned with `--serve <port> --host <host>` so the web UI
   *      rebinds to the same port. The browser's WebSocket auto-reconnect
   *      (src/web/src/main.ts) bridges the brief disconnect, so from the
   *      user's perspective the UI disconnects then resumes with cleared
   *      context.
   *
   * Teammates are child processes of the Lead; they die when the old Lead is
   * killed (process group), so they are naturally killed — no explicit
   * dismissal is needed at the Coordinator level.
   *
   * The graceful serve-shutdown handshake (serve_shutdown → serve_shutdown_done)
   * is reused from restart() so the Vite dev server and HTTP port are released
   * before the new Lead rebinds them — critical on Windows where SIGTERM →
   * TerminateProcess and no signal handler runs.
   *
   * @param serveActive - whether /serve was active on the old Lead
   * @param servePort - the port the old ServeHub was bound to (0 if not active)
   * @param serveHost - the host the old ServeHub was bound to (null = localhost)
   */
  async function reloadLead(
    serveActive: boolean,
    servePort: number,
    serveHost: string | null,
  ): Promise<void> {
    isRestarting = true;
    const previousLead = lead;

    // The old Lead's ServeHub is a Lead-process singleton; it is torn down
    // when the Lead exits. Reset serveMode now — the new Lead will re-enable
    // it via its own serve_mode IPC once activateServe() runs.
    const wasServeActive = serveMode;
    serveMode = false;

    // Kill old Lead. When serve was active, ask the Lead to shut down Vite
    // via IPC before SIGTERM so the next Lead won't hit EADDRINUSE on the
    // rebinding --serve port. Same Windows-safe pattern as restart().
    if (previousLead) {
      if (wasServeActive || serveActive) {
        let shutdownDone = false;
        const onShutdownDone = (msg: CoordinatorMessage) => {
          if (msg.type === 'serve_shutdown_done') shutdownDone = true;
        };
        previousLead.on('message', onShutdownDone);
        previousLead.send({ type: 'serve_shutdown' });
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(() => resolve(), 1500);
          const check = setInterval(() => {
            if (shutdownDone || previousLead.killed) {
              clearTimeout(deadline);
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
        previousLead.off('message', onShutdownDone);
      }
      previousLead.kill('SIGTERM');
      previousLead.unref();
    }

    // Build args for the new Lead:
    //   - NO --from flag → fresh session, no context pre-population
    //   - If serve was active, forward --serve <port> (and --host) so the
    //     new Lead re-activates the web UI on the same port/interface.
    //     The Lead's agent-repl.ts checks shouldServe() + getServePort()/
    //     getServeHost() and calls activateServe(), rebinding the same port.
    const reloadArgs: string[] = [];
    if (serveActive && servePort > 0) {
      reloadArgs.push('--serve', String(servePort));
      if (serveHost) {
        reloadArgs.push('--host', serveHost);
      }
    }

    const currentLead = startLead(reloadArgs);
    lead = currentLead;

    // Wait for ready signal. If the new Lead exits before sending 'ready',
    // exit the Coordinator instead of hanging forever.
    let settled = false;
    await new Promise<void>((resolve) => {
      const onReady = (msg: CoordinatorMessage) => {
        if (msg.type === 'ready' && !settled) {
          settled = true;
          currentLead.off('message', onReady);
          currentLead.off('exit', onFail);
          resolve();
        }
      };
      const onFail = (_code: number | null) => {
        if (!settled) {
          settled = true;
          currentLead.off('message', onReady);
          console.error(chalk.red('New lead process exited unexpectedly during reload.'));
          process.exit(1);
        }
      };
      currentLead.on('message', onReady);
      currentLead.on('exit', onFail);
    });

    isRestarting = false;
  }

  // ---------------------------------------------------------------------------
  // Terminal Setup
  // ---------------------------------------------------------------------------

  // Set up raw mode and handle native stdin data events
  // Forward structured key events to Lead via IPC
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on('data', (data: Buffer) => {
      // Ctrl+C — exit the process tree.
      // When serve mode is active we ask the Lead to shut down the Vite
      // dev server via IPC before killing it, so the HTTP port is released
      // cleanly (avoids orphaning Vite on Windows where lead.kill() calls
      // TerminateProcess and no signal handler runs).
      if (isCtrlC(data)) {
        console.log(chalk.yellow('\nCtrl+C - Exiting...'));

        // Second Ctrl+C while already shutting down serve: skip the IPC
        // round-trip and force-kill immediately.
        if (shuttingDownServe) {
          if (serveShutdownTimer) { clearTimeout(serveShutdownTimer); serveShutdownTimer = null; }
          shuttingDownServe = false;
          forceKillLead();
          cleanup();
          process.exit(130);
        }

        // Serve mode active — give the Lead a chance to shut down Vite.
        if (lead && serveMode) {
          shuttingDownServe = true;
          serveShutdownTimer = setTimeout(() => {
            serveShutdownTimer = null;
            shuttingDownServe = false;
            forceKillLead();
            cleanup();
            process.exit(130);
          }, 3000);
          if (serveShutdownTimer.unref) serveShutdownTimer.unref();
          lead.send({ type: 'serve_shutdown' });
          return;
        }

        // No serve running — kill immediately.
        forceKillLead();
        cleanup();
        process.exit(130);
      }

      // ESC - send neglection IPC
      if (isEscape(data)) {
        lead?.send({ type: 'neglection' });
        return;
      }

      // Serve mode: silently drop all other keys (terminal is read-only).
      // ESC (above) and Ctrl+C (above) are the only forwarded keys.
      // The real safety boundary is in Lead: when serve is running,
      // WebInputProvider does not create a LineEditor, so any leaked
      // keys have no receiver and are silently dropped.
      if (serveMode) {
        return;
      }

      // Parse and forward structured key events
      // Single keys are sent individually for responsiveness.
      // Multiple keys from one data event (paste) are batched so
      // the line editor can insert them atomically without the
      // first return key prematurely submitting the input.
      const keys = parseKeys(data);
      if (keys.length === 1) {
        lead?.send({ type: 'key', key: keys[0] });
      } else if (keys.length > 1) {
        lead?.send({ type: 'key-batch', keys });
      }
    });
  }

  /**
   * Force-kill the current Lead process (SIGTERM, with SIGKILL fallback
   * after 5 s). Safe to call when lead is null (no-op).
   *
   * On Unix the negative-PID kill targets the process group (if the Lead is
   * a group leader); on Windows it throws and we fall back to direct kill.
   */
  function forceKillLead(): void {
    if (!lead) return;
    try {
      process.kill(-lead.pid!, 'SIGTERM');
    } catch {
      lead.kill('SIGTERM');
    }
    const tk = setTimeout(() => {
      try {
        process.kill(-lead!.pid!, 'SIGKILL');
      } catch {
        lead!.kill('SIGKILL');
      }
    }, 5000);
    if (tk.unref) tk.unref();
  }

  function cleanup(): void {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Signal Handling
  // ---------------------------------------------------------------------------

  // SIGTERM - sent by external processes (e.g., `kill <pid>`), NOT triggered by Ctrl+C
  // (Ctrl+C is handled by stdin data handler in raw mode, see line ~210)
  process.on('SIGTERM', () => {
    if (lead) {
      lead.kill('SIGTERM');
    } else {
      cleanup();
      process.exit(0);
    }
  });

  // Safety net: ensures cleanup runs on any process exit, even if explicit cleanup()
  // call is missed. Safe to call multiple times (setRawMode(false) is idempotent).
  process.on('exit', cleanup);

  // ---------------------------------------------------------------------------
  // Entry Point
  // ---------------------------------------------------------------------------

  lead = startLead(process.argv.slice(2));

  // Handle terminal resize - forward to Lead
  // Multiple methods to ensure resize events are captured:

  // Method 1: SIGWINCH signal
  process.on('SIGWINCH', () => {
    const columns = process.stdout.columns || 80;
    lead?.send({ type: 'resize', columns });
  });

  // Method 2: stdout resize event (Node.js TTY)
  if (process.stdout.isTTY) {
    process.stdout.on('resize', () => {
      const columns = process.stdout.columns || 80;
      lead?.send({ type: 'resize', columns });
    });
  }

  // Method 3: stdin resize event (for raw mode)
  if (process.stdin.isTTY) {
    process.stdin.on('resize', () => {
      const columns = process.stdout.columns || 80;
      lead?.send({ type: 'resize', columns });
    });
  }

  // Method 4: Poll as fallback
  let lastColumns = process.stdout.columns || 80;
  setInterval(() => {
    const currentColumns = process.stdout.columns || 80;
    if (currentColumns !== lastColumns) {
      lastColumns = currentColumns;
      lead?.send({ type: 'resize', columns: currentColumns });
    }
  }, 300);

  /**
   * Spawn the Lead as a detached background process (daemon mode).
   *
   * `--daemon` makes the Coordinator spawn the Lead with stdout/stderr/stdin
   * disconnected (no terminal), detached from the parent process group, then
   * `child.unref()` so the Coordinator can exit without waiting. The
   * Coordinator prints the daemon PID and exits 0 immediately.
   *
   * IPC is kept (`stdio: ['ignore','ignore','ignore','ipc']`) so the Lead's
   * `process.send` guard passes and it can start — without IPC, agent-repl.ts
   * refuses to boot. The Lead sends 'ready'/'exit' IPC messages after the
   * Coordinator has already exited; they are harmlessly dropped (no listener).
   * The loader's `skill_reindex` IPC signal is also dropped (no Coordinator to
   * relay it), but the loader guards on `process.send` so it no-ops safely.
   *
   * The Lead receives all original CLI args (including `--daemon <skill>`
   * and `--skip-healthcheck`) and runs headless in auto mode — no raw-mode
   * stdin setup, no resize forwarding, no IPC forwarding loop.
   *
   * ── Verbose capture under -v ──
   * stdio stays 'ignore' even in verbose mode: the Lead installs its OWN
   * `installVerboseLog('lead')` tee (lead.ts), which intercepts
   * `process.stdout.write` and writes to `.mycc/verbose-lead-<ts>.log`
   * *before* forwarding to the (black-hole) stdout. So the file captures
   * the Lead's output regardless of stdio. We do NOT switch to 'pipe'
   * here because the Coordinator exits immediately after spawning — an
   * undrained pipe would fill its buffer and block the Lead.
   *
   * To diagnose a daemon that exits silently, attach listeners (only in
   * verbose mode) for the child's 'exit'/'error'/'message' events and log
   * them to the coordinator log BEFORE calling process.exit(0). This gives
   * a small window (the listeners fire asynchronously after unref) during
   * which an early exit code is captured — though once the Coordinator
   * exits, later events are lost. The Lead's own log file is the durable
   * record; this coordinator-side logging is a best-effort supplement.
   */
  function startDaemonLead(): void {
    const tsxScript = resolve(PROJECT_ROOT, 'src', 'lead.ts');

    // Forward all original CLI args (they already include --daemon/--skip-healthcheck).
    const forwardedArgs = process.argv.slice(2);

    const env = { ...process.env };
    env.COLUMNS = process.env.COLUMNS || '120';
    env.MYCC_COORDINATOR_PID = String(process.pid);

    // On Windows, spawn the native Go wrapper (bin/mycc-daemon.exe) which
    // calls CreateProcessW with CREATE_NEW_CONSOLE + STARTF_USESHOWWINDOW +
    // SW_HIDE. This gives the Lead a HIDDEN console that all its child
    // processes (cmd.exe from execSync) inherit — eliminating the console
    // window flashing that occurs when a detached Lead (DETACHED_PROCESS =
    // no console) spawns cmd.exe which self-allocates a visible console.
    //
    // The wrapper is a one-shot launcher: it spawns the Lead and exits
    // immediately. The Lead survives because CREATE_NEW_CONSOLE puts it in
    // its own console process group. No IPC is used (the daemon Lead's IPC
    // is fire-and-forget — the Coordinator exits right after, so messages
    // are harmlessly dropped). See docs/lead-detach-issue-solution.md.
    //
    // Fallback: when the wrapper binary is missing (e.g. built from source
    // without Go, or on a non-Windows platform), use the existing spawnTsx
    // approach. The flash issue is Windows-only; Unix uses process groups,
    // not consoles, so spawnTsx is correct there.
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
        // stdio: no IPC channel — the Go wrapper can't do Node.js IPC, and
        // the daemon Lead's IPC is fire-and-forget anyway (Coordinator exits
        // immediately). The Lead's IPC guard is relaxed for daemon mode
        // (agent-repl.ts) so it boots without process.send.
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        // detached: true so the wrapper survives the Coordinator's exit.
        // The wrapper itself is a one-shot launcher (exits right after
        // CreateProcessW), but detached keeps it from being killed by the
        // Coordinator's CTRL_CLOSE_EVENT before it can spawn the Lead.
        detached: true,
      });
    } else {
      child = spawnTsx({
        script: tsxScript,
        args: forwardedArgs,
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env,
        // Detach the daemon Lead into its own process group so it survives the
        // Coordinator's exit. Without `detached: true`, Windows sends a
        // CTRL_CLOSE_EVENT to the whole console group when the Coordinator
        // exits, killing the Lead — this was the root cause of the daemon's
        // silent exit within seconds of startup. On Unix, detached makes the
        // child a new process-group leader so it is not reached by a SIGINT
        // sent to the parent's group. Combined with child.unref() below, the
        // Coordinator can exit 0 immediately while the Lead keeps running.
        detached: true,
      });
    }

    // Verbose-mode diagnostics: log daemon lifecycle events to the
    // coordinator log. These fire asynchronously; since the Coordinator
    // exits right after this, only events that arrive in the brief window
    // before exit are captured. The durable record is the Lead's own
    // verbose-lead-<ts>.log (installed inside the Lead process).
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
    // On Unix, stdio:'ignore' + unref() is sufficient — the child becomes
    // orphaned (reparented to init) and keeps running. On Windows, the child
    // has no console window because stdout/stderr are ignored.
    child.unref();

    console.log(chalk.green(`Daemon started (pid: ${child.pid}).`));

    // In verbose mode, hold the Coordinator alive briefly so the daemon's
    // early lifecycle events (exit/error/ready IPC) are captured in the
    // coordinator log before we exit. If the daemon exits within this
    // window (the silent-exit bug), the 'exit' listener above logs the code
    // and we exit immediately. Otherwise we exit after the grace period and
    // let the daemon run on. The durable record is the Lead's own
    // verbose-lead-<ts>.log.
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
        process.exit(0);
      }, graceMs).unref?.();
      return;
    }

    process.exit(0);
  }
}