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

import chalk from 'chalk';
import { isVerbose, printEnvStatus, validateEnv, loadEnv } from './config.js';
import { main } from './loop/agent-repl.js';

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

loadEnv();

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