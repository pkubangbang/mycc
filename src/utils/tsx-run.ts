/**
 * tsx-run.ts - Cross-platform TypeScript execution via tsx
 *
 * Provides a unified way to spawn TypeScript files using tsx,
 * handling platform differences between Windows and Unix.
 *
 * ## Usage
 *
 * ```typescript
 * import { spawnTsx, getProjectRoot } from './utils/tsx-run.js';
 *
 * // Get project root for resolving paths
 * const PROJECT_ROOT = getProjectRoot();
 *
 * // Simple spawn with inherited stdio
 * const child = spawnTsx({ script: resolve(PROJECT_ROOT, 'src', 'script.ts') });
 *
 * // With custom options
 * const child = spawnTsx({
 *   script: '/path/to/script.ts',
 *   args: ['--flag', 'value'],
 *   cwd: '/working/dir',
 *   stdio: 'inherit',
 * });
 * ```
 *
 * ## Platform Differences
 *
 * - **Unix**: Uses `node_modules/.bin/tsx` binary directly
 * - **Windows**: Uses `node --import` with tsx ESM loader (file:// URL required)
 *
 * ## Build-less Architecture
 *
 * This utility supports running TypeScript files directly without compilation,
 * which is essential for mycc's build-less development approach.
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { resolve, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

/**
 * Find the project root directory by searching for package.json with name "mycc"
 * This is more reliable than hardcoding relative paths
 */
function findProjectRoot(): string {
  // Start from this file's directory and go up until we find mycc's package.json
  const thisFileDir = dirname(fileURLToPath(import.meta.url));
  let currentDir = thisFileDir;
  
  while (currentDir !== '/') {
    const packageJsonPath = resolve(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, 'utf8');
        const pkg = JSON.parse(content);
        if (pkg.name === 'mycc') {
          return currentDir;
        }
      } catch {
        // Ignore parse errors
      }
    }
    const parent = dirname(currentDir);
    // Filesystem-root guard: on Windows `dirname('C:\\') === 'C:\\'`, so the
    // `currentDir !== '/'` loop condition never becomes false and the loop
    // would spin forever if no `mycc` package.json is found upward. Break
    // once dirname stops advancing (hit a drive root on Windows, or `/` on
    // Unix — where this guard is a no-op since the while condition already
    // catches it). Defensive: normal install trees find package.json long
    // before this triggers.
    if (parent === currentDir) break;
    currentDir = parent;
  }
  
  // Fallback: go up from src/utils to project root
  return resolve(thisFileDir, '..', '..');
}

// Cache the project root once found
const PROJECT_ROOT = findProjectRoot();

/**
 * Get the project root directory
 * Returns the cached project root found at module load time
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

/**
 * Get the path to tsx ESM loader
 * Uses import.meta.resolve for ESM-compatible path resolution
 *
 * Exported so the Coordinator (src/index.ts) can pass the loader path to the
 * native Go daemon wrapper (bin/mycc-daemon.exe), which spawns node.exe with
 * `--import <loader>` via CreateProcessW. The wrapper needs the resolved
 * loader URL because it runs outside the tsx context.
 */
export function getTsxLoaderPath(): string {
  try {
    // Use import.meta.resolve to find tsx/esm module path
    const resolved = import.meta.resolve('tsx/esm');
    return resolved;
  } catch {
    // Fallback to hardcoded path if import.meta.resolve fails
    return pathToFileURL(resolve(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
  }
}

/**
 * Get the path to tsx binary
 */
function getTsxBinaryPath(): string {
  return resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
}

/**
 * Result of getTsxCommand
 */
interface TsxCommand {
  /** Command to spawn (node or tsx binary) */
  command: string;
  /** Base arguments (loader + script path) */
  baseArgs: string[];
}

/**
 * Get the spawn command and base args for running a TypeScript file
 *
 * @param script - Absolute path to the TypeScript file to run
 * @returns Object with command and base args for spawn()
 *
 * @example
 * ```typescript
 * const { command, baseArgs } = getTsxCommand('/path/to/script.ts');
 * spawn(command, [...baseArgs, '--my-flag'], { stdio: 'inherit' });
 * ```
 */
function getTsxCommand(script: string): TsxCommand {
  // Validate script path is absolute
  const resolved = resolve(script);
  if (!resolved.startsWith('/') && !resolved.match(/^[A-Z]:\\/i)) {
    throw new Error(`Script path must be absolute: ${script}`);
  }

  if (process.platform === 'win32') {
    // Windows: use node --import with tsx/esm loader
    // Requires file:// URL for ESM compatibility
    const loaderPath = getTsxLoaderPath();
    return {
      command: process.execPath,
      baseArgs: ['--import', loaderPath, script],
    };
  }

  // Unix: use tsx binary directly
  const tsxPath = getTsxBinaryPath();
  return {
    command: tsxPath,
    baseArgs: [script],
  };
}

/**
 * Options for spawnTsx
 */
interface TsxSpawnOptions {
  /** Absolute path to the TypeScript file to run */
  script: string;
  /** Additional arguments to pass after the script */
  args?: string[];
  /** Working directory for the spawned process */
  cwd?: string;
  /** Environment variables (defaults to process.env) */
  env?: NodeJS.ProcessEnv;
  /** stdio configuration (defaults to 'inherit') */
  stdio?: SpawnOptions['stdio'];
  /**
   * Detach the child from the parent's process group / controlling terminal.
   *
   * On Unix, `detached: true` makes the child a new process-group leader
   * (so it survives the parent's exit and is not killed by a SIGINT sent to
   * the parent's group). On Windows, `detached: true` is required for the
   * child to outlive the parent — without it, when the parent exits Windows
   * sends a CTRL_CLOSE_EVENT to the whole console process group, killing
   * every child that shares the parent's console. The daemon Lead MUST be
   * spawned detached so it keeps running after the Coordinator exits.
   *
   * Callers that set this should also call `child.unref()` so the parent
   * does not wait for the child.
   */
  detached?: boolean;
}

/**
 * Spawn a TypeScript file using tsx
 *
 * This is the recommended way to run TypeScript files in mycc.
 * It handles platform differences internally.
 *
 * @param options - Spawn options
 * @returns The spawned ChildProcess
 *
 * @example
 * ```typescript
 * // Run setup script
 * const child = spawnTsx({
 *   script: resolve(PROJECT_ROOT, 'src', 'setup', 'index.ts'),
 *   stdio: 'inherit',
 * });
 * child.on('exit', (code) => process.exit(code ?? 0));
 * ```
 *
 * @example
 * ```typescript
 * // Run with custom args and cwd
 * const child = spawnTsx({
 *   script: resolve(PROJECT_ROOT, 'src', 'lead.ts'),
 *   args: ['--session', sessionId],
 *   cwd: workDir,
 *   stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
 * });
 * ```
 */
export function spawnTsx(options: TsxSpawnOptions): ChildProcess {
  const { command, baseArgs } = getTsxCommand(options.script);
  const args = [...baseArgs, ...(options.args ?? [])];

  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    detached: options.detached ?? false,
  };

  return spawn(command, args, spawnOptions);
}