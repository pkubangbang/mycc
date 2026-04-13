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
 */

import { spawn, ChildProcess } from 'child_process';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { isVerbose, printEnvStatus, validateEnv } from './config.js';

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL_ENV = resolve(homedir(), '.mycc', '.env');
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
let previousLeadExitHandled = false;

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

  const child = spawn(command, [...baseArgs, ...forwardedArgs], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  // Forward I/O
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  process.stdin.pipe(child.stdin!);

  // Handle IPC
  child.on('message', (msg: CoordinatorMessage) => {
    if (msg.type === 'restart') {
      restart(msg.sessionId, msg.cwd);
    } else if (msg.type === 'exit') {
      // Lead requested exit - kill it cleanly
      child.kill('SIGTERM');
    }
  });

  // When lead closes its stdin, it's done with input
  child.stdin?.on('close', () => {
    // Lead no longer needs input, but coordinator should keep running
    // until lead exits
  });

  // Handle exit - cleanup and exit coordinator
  child.on('exit', (code) => {
    // Only exit coordinator if this is the current lead and we're not restarting
    if (child === lead && !isRestarting) {
      // Cleanup pipes
      child.stdout?.unpipe();
      child.stderr?.unpipe();
      process.stdin.unpipe();
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
  previousLeadExitHandled = false;
  const previousLead = lead;

  // Disconnect stdin from old Lead and pause to prevent data loss
  process.stdin.unpipe();
  process.stdin.pause();

  // Kill old Lead cleanly
  if (previousLead) {
    // Mark that we expect this lead to exit (don't propagate its exit code)
    previousLead.on('exit', () => {
      previousLeadExitHandled = true;
    });
    previousLead.kill('SIGTERM');
    previousLead.unref(); // Allow process to exit if only this remains
  }

  // Resume stdin and start new Lead
  process.stdin.resume();
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
// Signal Handling
// ---------------------------------------------------------------------------

function forwardSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  if (lead) {
    lead.kill(signal);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

lead = startLead(process.argv.slice(2));