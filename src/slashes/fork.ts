/**
 * /fork command - Run a new mycc instance in parallel from current session
 *
 * Usage:
 *   /fork                                - Start a new mycc instance
 *   /fork --env KEY=VALUE                - Forward an env var to the instance
 *   /fork --env KEY1=V1 --env KEY2=V2    - Forward multiple env vars
 *
 * The forked instance reads its own config from .env files (just like the
 * original) — user-level ~/.mycc-store/.env and project-level .mycc/.env.
 * Use --env to forward shell-level env vars that aren't in .env files.
 *
 * Flow:
 *   1. Get current session ID from session file path
 *   2. Build the mycc startup command (tsx + session flag)
 *   3. Open a new native terminal window running that command
 *   4. Old mycc instance keeps running; both run in parallel
 *
 * Design reference: docs/fork-design.md
 */

import type { SlashCommand, SlashCommandContext } from '../types.js';
import chalk from 'chalk';
import { resolve } from 'path';
import { getSessionId } from '../session/index.js';
import { getProjectRoot } from '../utils/tsx-run.js';
import { shouldSkipHealthCheck } from '../config.js';
import { openTerminal } from '../utils/open-terminal.js';

// ---------------------------------------------------------------------------
// --env flag support
// ---------------------------------------------------------------------------

/**
 * Parse --env KEY=VALUE arguments from the fork command.
 * Returns shell export statements for each override.
 */
function buildEnvExports(context: SlashCommandContext): string {
  const args = context.args;
  const exports: string[] = [];

  const isWin = process.platform === 'win32';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--env' && i + 1 < args.length) {
      const envArg = args[i + 1];
      i++; // consume the value
      const eqIdx = envArg.indexOf('=');
      if (eqIdx === -1) {
        console.log(chalk.yellow(`  Warning: --env "${envArg}" has no '=' sign, skipping.`));
        continue;
      }
      const key = envArg.slice(0, eqIdx).trim();
      let value = envArg.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if (value.length >= 2) {
        const q = value[0];
        if ((q === '"' || q === "'") && value.endsWith(q)) {
          value = value.slice(1, -1);
        }
      }
      if (key) {
        if (isWin) {
          // PowerShell syntax: $env:KEY='value'
          const escaped = value.replace(/'/g, "''");
          exports.push(`$env:${key}='${escaped}';`);
        } else {
          // Unix shell syntax: export KEY='value'
          const escaped = value.replace(/'/g, "'\\''");
          exports.push(`export ${key}='${escaped}';`);
        }
      }
    }
  }

  return exports.join('\n');
}

// ---------------------------------------------------------------------------
// Build the mycc shell command
// ---------------------------------------------------------------------------

/**
 * Build the shell command string to start mycc with a given session.
 *
 * Strategy:
 *  - On Unix: use the tsx binary directly (same as how index.ts spawns children)
 *  - On Windows: use the global `mycc` command (via npm wrapper)
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

function printManualInstructions(sessionId: string, workDir: string): void {
  const skipFlag = shouldSkipHealthCheck() ? ' --skip-healthcheck' : '';
  const isWin = process.platform === 'win32';
  console.log(chalk.yellow('\nCould not open a terminal window automatically.'));
  console.log(chalk.cyan('\nTo fork, open a new terminal and run:'));
  if (isWin) {
    console.log(chalk.white(`  cd "${workDir}"`));
    console.log(chalk.white(`  mycc --session ${sessionId}${skipFlag}`));
  } else {
    console.log(chalk.white(`  cd ${workDir}`));
    console.log(chalk.white(`  mycc --session ${sessionId}${skipFlag}`));
  }
}

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Start a new mycc instance from current session. Use --env KEY=VALUE to forward environment variables.',
  handler: (context) => {
    try {
      // Step 1: Parse --env overrides
      const envExports = buildEnvExports(context);

      // Step 2: Get current session ID
      const sessionId = getSessionId(context.sessionFilePath);

      // Step 3: Get working directory
      const workDir = context.ctx.core.getWorkDir();

      // Step 4: Build the mycc command
      const shellCommand = buildMyccShellCommand(sessionId);

      // Step 5: Prepend --env exports if any
      const commandWithEnv = envExports ? `${envExports}\n${shellCommand}` : shellCommand;

      // Step 6: Prepend cd to workDir so the new terminal starts in the right directory
      // Use platform-appropriate syntax: Unix uses "cd dir && cmd", Windows PowerShell uses "cd 'dir'; cmd"
      const isWin = process.platform === 'win32';
      const fullCommand = isWin
        ? `Set-Location '${workDir.replace(/'/g, "''")}'; ${commandWithEnv}`
        : `cd "${workDir}" && ${commandWithEnv}`;

      // Step 7: Open in native terminal
      console.log(chalk.cyan(`\nForking session ${sessionId.slice(0, 7)}...`));

      try {
        openTerminal(fullCommand);
        console.log(chalk.green('✓ New mycc instance opened in a terminal window.'));
        console.log(chalk.gray(`  Session ID: ${sessionId}`));
        console.log(chalk.gray(`  Working directory: ${workDir}`));
      } catch (err) {
        // openTerminal throws if no terminal is found
        console.error(chalk.red((err as Error).message));
        printManualInstructions(sessionId, workDir);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Failed to fork session: ${message}`));
    }
  },
};