/**
 * restart.ts - Utility for restarting mycc in a different directory
 *
 * ## Purpose
 *
 * When a user runs `/load <session-id>` from a directory that doesn't match the
 * session's recorded `project_dir`, we need to restart mycc in the correct directory.
 * This module provides the mechanism to spawn a new mycc process and gracefully
 * hand over control.
 *
 * ## Core Principle: IPC Handshake
 *
 * The restart uses a simple IPC (Inter-Process Communication) handshake protocol
 * to ensure a clean handover:
 *
 * 1. **Parent spawns child** with `--session` flag and IPC channel enabled
 * 2. **Child initializes** (health check, session loading, etc.)
 * 3. **Child emits "ready"** via IPC when fully initialized
 * 4. **Parent sees "ready"** and calls `process.exit(0)` to hand over terminal
 * 5. **Child continues** with inherited terminal (stdin/stdout/stderr)
 *
 * ## Why IPC instead of stdout?
 *
 * - stdout is for user output; control signals shouldn't pollute it
 * - IPC is a dedicated channel that doesn't interfere with user-facing output
 * - More reliable than string matching on stdout
 *
 * ## Execution Mode Detection
 *
 * The spawned command depends on how mycc was started:
 *
 * - **Development (`pnpm start` / tsx)**: Use local tsx from node_modules
 *   to run the live TypeScript source code
 * - **Production (installed `mycc`)**: Use the `mycc` command directly
 *
 * Detection is based on whether `process.argv[1]` (entry point) starts with
 * the package root directory.
 *
 * ## Error Handling
 *
 * If the child process fails (exit code != 0), the parent process stays alive
 * and shows an error message. This allows the user to try again or manually
 * run the command.
 */

import { execa } from 'execa';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Get the spawn command and args based on how mycc is running.
 * - From source (tsx): use local tsx from node_modules
 * - From installed (dist): use mycc command
 */
function getSpawnCommand(): { command: string; args: string[] } {
  const entry = process.argv[1] || '';
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(__dirname, '..', '..');

  // If running from source (entry starts with package root), use tsx
  if (entry.startsWith(packageRoot)) {
    const tsxPath = resolve(packageRoot, 'node_modules', '.bin', 'tsx');
    return { command: tsxPath, args: [resolve(packageRoot, 'src', 'index.ts')] };
  }
  return { command: 'mycc', args: [] };
}

/**
 * Result of restart attempt
 */
export interface RestartResult {
  success: boolean;
  error?: string;
}

/**
 * Spawn a new mycc process in detached mode.
 * Parent exits immediately; child reopens terminal for input.
 *
 * @param sessionId - Session ID to load
 * @param cwd - Working directory for the new process
 * @returns Result indicating success or failure
 */
export async function restartInDirectory(sessionId: string, cwd: string): Promise<RestartResult> {
  const { command, args } = getSpawnCommand();

  try {
    execa(command, [...args, '--session', sessionId], {
      cwd,
      stdio: 'ignore', // Don't inherit stdin/stdout/stderr
      detached: true, // Child runs independently
      preferLocal: true,
      reject: false,
    });

    // Parent exits immediately; child will open /dev/tty for input
    process.exit(0);

    // Never reached
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}