#!/usr/bin/env node
/**
 * index.ts - Entry point for the coding agent
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

// Load .env from: 1) current directory, 2) ~/.mycc/.env
const localEnv = resolve(process.cwd(), '.env');
const globalEnv = resolve(homedir(), '.mycc', '.env');

if (existsSync(localEnv)) {
  config({ path: localEnv });
} else if (existsSync(globalEnv)) {
  config({ path: globalEnv });
}

import { main } from './loop/agent-loop.js';

main().catch(console.error);