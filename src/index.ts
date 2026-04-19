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

import { spawn, ChildProcess } from 'child_process';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { isVerbose, printEnvStatus, validateEnv } from './config.js';
import { parseKeys, isCtrlC, isEscape } from './utils/key-parser.js';
import type { KeyInfo } from './utils/key-parser.js';

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL_ENV = resolve(homedir(), '.mycc-store', '.env');
const LOCAL_ENV = resolve(process.cwd(), '.env');

// Load .env: global first, then local (local overrides global)
if (existsSync(GLOBAL_ENV)) config({ path: GLOBAL_ENV });
if (existsSync(LOCAL_ENV)) config({ path: LOCAL_ENV });

// Validate environment before proceeding
const envResult = validateEnv();
envResult.warnings.forEach(w => console.log(chalk.yellow(`[config] ${w.var}: ${w.instruction}`)));

if (!envResult.valid) {
  console.error(chalk.red('Missing required environment variables:'));
  envResult.missing.forEach(m => console.error(chalk.red(`  - ${m.var}: ${m.instruction}`)));
  process.exit(1);
}

if (isVerbose()) {
  console.log(chalk.magenta('[verbose] Debug logging enabled'));
  printEnvStatus();
}

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
// Spawn Command
// ---------------------------------------------------------------------------

interface SpawnCommand {
  command: string;
  args: string[];
}

/** Determine how to spawn Lead based on current execution context */
function getSpawnCommand(): SpawnCommand {
  const entry = process.argv[1] || '';
  const isDev = entry.startsWith(PROJECT_ROOT);

  if (isDev) {
    return {
      command: resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
      args: [resolve(PROJECT_ROOT, 'src', 'lead.ts')],
    };
  }

  return {
    command: process.execPath,
    args: [resolve(PROJECT_ROOT, 'dist', 'lead.js')],
  };
}

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
  const { command, args: baseArgs } = getSpawnCommand();

  // Forward skip-healthcheck flag if set
  const forwardedArgs = skipHealthCheck
    ? [...args, '--skip-healthcheck']
    : args;

  // Pass terminal columns to Lead process for proper line wrapping
  const env = { ...process.env };
  // Use COLUMNS env var if set, otherwise use process.stdout.columns
  env.COLUMNS = process.env.COLUMNS || String(process.stdout.columns || 80);

  const child = spawn(command, [...baseArgs, ...forwardedArgs], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env,
  });

  // Forward output
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

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
      // Cleanup pipes
      child.stdout?.unpipe();
      child.stderr?.unpipe();
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

    // Normal mode - parse and forward structured key events
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