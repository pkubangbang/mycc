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

import { ChildProcess } from 'child_process';
import { resolve } from 'path';
import chalk from 'chalk';
import { isVerbose, validateEnv, ensureToolTypeImports, shouldRunSetup, loadEnv, shouldServe } from './config.js';
import { agentIO } from './loop/agent-io.js';
import { parseKeys, isCtrlC, isEscape } from './utils/key-parser.js';
import { getProjectRoot, spawnTsx } from './utils/tsx-run.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = getProjectRoot();

// Set process title so it shows as 'mycc' in process list (ps, top, etc.)
process.title = 'mycc';

// Set terminal window title to 'mycc' (works in most terminal emulators)
// ANSI escape sequence: ESC ] 0 ; <title> BEL
if (process.stdout.isTTY) {
  process.stdout.write('\x1b]0;mycc\x07');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** IPC message from Lead to Coordinator */
type CoordinatorMessage =
  | { type: 'ready' }
  | { type: 'restart'; sessionId: string; cwd: string }
  | { type: 'exit' }
  | { type: 'serve_mode'; active: boolean }
  | { type: 'serve_shutdown_done' };

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
  }

  // Ensure type imports work for custom tools
  ensureToolTypeImports();

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

  // Flags to forward to lead processes
  const skipHealthCheck = process.argv.includes('--skip-healthcheck');

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
    const currentLead = startLead(['--session', sessionId], cwd);
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
}