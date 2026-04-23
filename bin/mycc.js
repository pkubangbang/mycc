#!/usr/bin/env node
/**
 * mycc - CLI wrapper that invokes tsx to run TypeScript directly
 *
 * This wrapper allows mycc to run TypeScript files without compilation.
 * On Unix: uses tsx binary directly
 * On Windows: uses node --import with tsx/esm loader (file:// URL for ESM compatibility)
 */

import { resolve, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, '..');
const entry = resolve(PROJECT_ROOT, 'src', 'index.ts');
const isWin = process.platform === 'win32';

let child;
if (isWin) {
  // Windows: use node --import with tsx/esm loader (requires file:// URL)
  const tsxEsmPath = resolve(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  const tsxEsmUrl = pathToFileURL(tsxEsmPath).href;
  child = spawn(process.execPath, ['--import', tsxEsmUrl, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
} else {
  // Unix: use tsx binary directly
  const tsx = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  child = spawn(tsx, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
}

child.on('exit', (code) => process.exit(code ?? 0));