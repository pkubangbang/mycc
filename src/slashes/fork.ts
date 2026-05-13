/**
 * /fork command - Run a new mycc instance in parallel from current session
 *
 * Usage:
 *   /fork - Start a new mycc instance with the current session
 *
 * Flow:
 *   1. Get current session ID from session file path
 *   2. Build the mycc startup command (tsx + session flag)
 *   3. Open a new native terminal window running that command
 *   4. Old mycc instance keeps running; both run in parallel
 *
 * Design reference: docs/fork-design.md
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { resolve } from 'path';
import { getSessionId } from '../session/index.js';
import { getProjectRoot } from '../utils/tsx-run.js';
import { shouldSkipHealthCheck } from '../config.js';
import { openTerminal } from '../utils/open-terminal.js';

// ---------------------------------------------------------------------------
// Build the mycc shell command
// ---------------------------------------------------------------------------

/**
 * Build the shell command string to start mycc with a given session.
 *
 * Strategy:
 *  - On Unix: use the tsx binary directly (same as how index.ts spawns children)
 *  - On Windows: fall back to the global `mycc` command
 *
 * Forwards --skip-healthcheck if the current instance was started with it.
 */
function buildMyccShellCommand(sessionId: string): string {
  const projectRoot = getProjectRoot();
  const coordinatorScript = resolve(projectRoot, 'src', 'index.ts');

  const flags = [`--session ${sessionId}`];
  if (shouldSkipHealthCheck()) {
    flags.push('--skip-healthcheck');
  }

  if (process.platform === 'win32') {
    return `mycc ${flags.join(' ')}`;
  }

  const tsxPath = resolve(projectRoot, 'node_modules', '.bin', 'tsx');
  return `${tsxPath} ${coordinatorScript} ${flags.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Manual instructions fallback
// ---------------------------------------------------------------------------

function printManualInstructions(sessionId: string): void {
  const skipFlag = shouldSkipHealthCheck() ? ' --skip-healthcheck' : '';
  console.log(chalk.yellow('\nCould not open a terminal window automatically.'));
  console.log(chalk.cyan('\nTo fork, open a new terminal and run:'));
  console.log(chalk.white(`  mycc --session ${sessionId}${skipFlag}`));
}

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Start a new mycc instance from current session',
  handler: (context) => {
    try {
      // Step 1: Get current session ID
      const sessionId = getSessionId(context.sessionFilePath);

      // Step 2: Get working directory
      const workDir = context.ctx.core.getWorkDir();

      // Step 3: Build the mycc command
      const shellCommand = buildMyccShellCommand(sessionId);

      // Step 4: Prepend cd to workDir so the new terminal starts in the right directory
      const fullCommand = `cd "${workDir}" && ${shellCommand}`;

      // Step 5: Open in native terminal
      console.log(chalk.cyan(`\nForking session ${sessionId.slice(0, 7)}...`));

      try {
        openTerminal(fullCommand);
        console.log(chalk.green('✓ New mycc instance opened in a terminal window.'));
        console.log(chalk.gray(`  Session ID: ${sessionId}`));
        console.log(chalk.gray(`  Working directory: ${workDir}`));
      } catch (err) {
        // openTerminal throws if no terminal is found
        console.error(chalk.red((err as Error).message));
        printManualInstructions(sessionId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Failed to fork session: ${message}`));
    }
  },
};