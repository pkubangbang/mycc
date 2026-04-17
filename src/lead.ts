/**
 * lead.ts - Lead agent entry point
 *
 * The Lead process runs the agent loop:
 * - Handles user interaction
 * - Spawns teammate processes
 * - Communicates with Coordinator via IPC
 *
 * Architecture:
 *   Terminal → Coordinator → Lead (this file) → Teammates
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import chalk from 'chalk';
import { isVerbose, printEnvStatus, validateEnv } from './config.js';
import { main } from './loop/agent-loop.js';

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const GLOBAL_ENV = resolve(homedir(), '.mycc-store', '.env');
const LOCAL_ENV = resolve(process.cwd(), '.env');

// Load .env: global first, then local (local overrides global)
if (existsSync(GLOBAL_ENV)) config({ path: GLOBAL_ENV });
if (existsSync(LOCAL_ENV)) config({ path: LOCAL_ENV });

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
// Entry Point
// ---------------------------------------------------------------------------

main().catch((err: Error) => {
  console.error('Fatal error:', err);
  process.exit(1);
});