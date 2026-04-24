#!/usr/bin/env node
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
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import chalk from 'chalk';
import { isVerbose, printEnvStatus, validateEnv, ensureToolTypeImports, shouldRunSetup } from './config.js';
import { parseKeys, isCtrlC, isEscape } from './utils/key-parser.js';
import { getProjectRoot, spawnTsx } from './utils/tsx-run.js';
import type { KeyInfo } from './utils/key-parser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = getProjectRoot();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** IPC message from Lead to Coordinator */
type CoordinatorMessage =
  | { type: 'ready' }
  | { type: 'restart'; sessionId: string; cwd: string }
  | { type: 'exit' };

/** IPC message from Coordinator to Lead */
export type CoordinatorToLeadMessage =
  | { type: 'neglection' }
  | { type: 'key'; key: KeyInfo }
  | { type: 'resize'; columns: number };

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

  const GLOBAL_ENV = resolve(homedir(), '.mycc-store', '.env');
  const LOCAL_ENV = resolve(process.cwd(), '.env');

  // Load .env: global first, then local (local overrides global)
  if (existsSync(GLOBAL_ENV)) config({ path: GLOBAL_ENV });
  if (existsSync(LOCAL_ENV)) config({ path: LOCAL_ENV });

  // Validate environment before proceeding
  const envResult = validateEnv();
  envResult.warnings.forEach(w => console.log(chalk.yellow(`[config] ${w.var}: ${w.instruction}`)));

  if (!envResult.valid) {
    console.error(chalk.red('\nMissing required environment variables:'));
    envResult.missing.forEach(m => console.error(chalk.red(`  - ${m.var}: ${m.instruction}`)));
    console.log(chalk.yellow('\nRun \'mycc --setup\' to configure your environment.'));
    process.exit(2);  // Exit code 2 = setup required
  }

  if (isVerbose()) {
    console.log(chalk.magenta('[verbose] Debug logging enabled'));
    printEnvStatus();
  }

  // Ensure type imports work for custom tools
  ensureToolTypeImports();

  // ---------------------------------------------------------------------------
  // Coordinator State
  // ---------------------------------------------------------------------------

  let lead: ChildProcess | null = null;
  let isRestarting = false;

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

    // Kill old Lead cleanly
    if (previousLead) {
      previousLead.kill('SIGTERM');
      previousLead.unref();
    }

    // Start new Lead (stdin forwarding continues automatically via data handler)
    lead = startLead(['--session', sessionId], cwd);

    // Wait for ready signal
    await new Promise<void>((resolve) => {
      const onReady = (msg: CoordinatorMessage) => {
        if (msg.type === 'ready') {
          lead!.off('message', onReady);
          resolve();
        }
      };
      lead!.on('message', onReady);
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
      // Ctrl+C - forcibly kill Lead and exit immediately
      if (isCtrlC(data)) {
        console.log(chalk.yellow('\nCtrl+C - Exiting...'));
        if (lead) {
          lead.kill('SIGKILL');
        }
        cleanup();
        process.exit(130);
      }

      // ESC - send neglection IPC
      if (isEscape(data)) {
        lead?.send({ type: 'neglection' });
        return;
      }

      // Parse and forward structured key events
      const keys = parseKeys(data);
      for (const key of keys) {
        lead?.send({ type: 'key', key });
      }
    });
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