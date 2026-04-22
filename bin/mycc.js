#!/usr/bin/env node
/**
 * mycc - CLI wrapper that invokes tsx to run TypeScript directly
 *
 * This wrapper allows mycc to run TypeScript files without compilation.
 * It ensures tsx is available and runs src/index.ts directly.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, '..');
const tsx = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const entry = resolve(PROJECT_ROOT, 'src', 'index.ts');

const child = spawn(tsx, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));