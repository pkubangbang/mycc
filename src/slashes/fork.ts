/**
 * /fork command - Save session and open in new tmux window (or print instructions)
 *
 * Usage:
 *   /fork - Save current session and open a new mycc instance (in tmux) or print instructions (outside tmux)
 *
 * Flow:
 *   1. Save current session to user directory
 *   2. If in tmux: spawn a new tmux window running mycc with the saved session
 *   3. If not in tmux: print instructions for starting a new session
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { saveToUserDir, getSessionId } from '../session/index.js';

export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Save session and open in new tmux window',
  handler: (context) => {
    const sessionPath = context.sessionFilePath;

    try {
      // Step 1: Save current session
      const savedPath = saveToUserDir(sessionPath);
      const sessionId = getSessionId(savedPath);

      console.log(chalk.green('Session saved successfully.'));
      console.log(chalk.gray(`Session ID: ${sessionId}`));
      console.log(chalk.gray(`Saved to: ~/.mycc-store/sessions`));

      // Step 2: Check if inside tmux
      const inTmux = process.env.TMUX !== undefined;

      if (!inTmux) {
        // Not in tmux - provide instructions for manual fork
        console.log(chalk.yellow('\nNot running inside tmux.'));
        console.log(chalk.cyan('\nTo fork, open a new terminal and run:'));
        console.log(chalk.white(`  mycc --session ${sessionId}`));
        console.log(chalk.gray('\nOr start a new tmux session:'));
        console.log(chalk.white(`  tmux new-session "mycc --session ${sessionId}"`));
        return;
      }

      // Step 3: Get tmux session name
      const tmuxSession = process.env.TMUX?.split(',')[1];
      if (!tmuxSession) {
        console.log(chalk.red('Error: Could not detect tmux session.'));
        console.log(chalk.cyan('\nTo fork, open a new terminal and run:'));
        console.log(chalk.white(`  mycc --session ${sessionId}`));
        return;
      }

      // Step 4: Create new window with mycc --session <id>
      console.log(chalk.cyan('\nOpening new window with saved session...'));

      const workDir = context.ctx.core.getWorkDir();

      // Create new tmux window
      const args = [
        'new-window',
        '-c', workDir,
        'mycc',
        '--session', sessionId,
      ];

      const child = spawn('tmux', args, {
        detached: true,
        stdio: 'ignore',
      });

      child.on('error', (err) => {
        console.error(chalk.red(`Failed to open new window: ${err.message}`));
        console.log(chalk.cyan('\nTo fork manually, open a new terminal and run:'));
        console.log(chalk.white(`  mycc --session ${sessionId}`));
      });

      child.unref();

      console.log(chalk.green('\n✓ New window opened.'));
      console.log(chalk.gray('Switch windows with: Ctrl+b n (next) / Ctrl+b p (previous)'));
      console.log(chalk.gray(`Or: tmux select-window -t <window>`));

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Failed to fork session: ${message}`));
    }
  },
};