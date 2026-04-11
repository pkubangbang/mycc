#!/usr/bin/env node
/**
 * index.ts - Entry point for the coding agent
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import chalk from 'chalk';

// Load .env from: 1) global ~/.mycc/.env, 2) current directory (local overrides)
const localEnv = resolve(process.cwd(), '.env');
const globalEnv = resolve(homedir(), '.mycc', '.env');

// Load global first (if exists), then local (if exists) - local values override global
if (existsSync(globalEnv)) {
  config({ path: globalEnv });
}
if (existsSync(localEnv)) {
  config({ path: localEnv });
}

// Import config AFTER .env is loaded
import { isVerbose, validateEnv, printEnvStatus } from './config.js';

// Validate environment and show instructions for missing vars
const envResult = validateEnv();

// Show warnings for optional env vars (always shown for important ones like EDITOR)
if (envResult.warnings.length > 0) {
  for (const warning of envResult.warnings) {
    console.log(chalk.yellow(`[config] ${warning.var}: ${warning.instruction}`));
  }
}

// Fail only if required vars are missing
if (!envResult.valid) {
  console.error(chalk.red('Missing required environment variables:'));
  for (const missing of envResult.missing) {
    console.error(chalk.red(`  - ${missing.var}: ${missing.instruction}`));
  }
  process.exit(1);
}

// Show verbose indicator and env status
if (isVerbose()) {
  console.log(chalk.magenta('[verbose] Debug logging enabled'));
  printEnvStatus();
}

import { main } from './loop/agent-loop.js';

main().catch(console.error);