/**
 * /plan command - Quick mode switching for plan mode
 *
 * Usage:
 *   /plan        - Display current mode
 *   /plan on     - Turn on plan mode (code changes prohibited)
 *   /plan off    - Turn off plan mode (return to normal)
 *   /plan on <file> - Turn on plan mode with one allowed file for editing
 */

import type { SlashCommand } from '../types.js';
import type { Core } from '../context/parent/core.js';
import type { TeamManager } from '../context/parent/team.js';
import path from 'path';
import chalk from 'chalk';

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Quick toggle for plan mode (on/off/with file)',
  handler: async (context) => {
    const { args, ctx } = context;
    const core = ctx.core as Core;
    const team = ctx.team as TeamManager;

    // No args: display current mode
    if (args.length <= 1) {
      const currentMode = core.getMode();
      const allowedFile = core.getAllowedFile();
      if (currentMode === 'plan') {
        if (allowedFile) {
          console.log(`Currently in ${chalk.yellow('PLAN')} mode.`);
          console.log(chalk.gray(`Allowed file: ${allowedFile}`));
        } else {
          console.log(`Currently in ${chalk.yellow('PLAN')} mode (strict - no files allowed).`);
        }
      } else {
        console.log(`Currently in ${chalk.green('NORMAL')} mode.`);
      }
      return;
    }

    // Get the subcommand
    const subcmd = args[1].toLowerCase();

    if (subcmd === 'on') {
      // Check if there's an allowed file specified
      const allowedFile = args.length > 2 ? args.slice(2).join(' ') : undefined;

      if (allowedFile) {
        // Resolve to absolute path
        const resolvedPath = path.isAbsolute(allowedFile)
          ? allowedFile
          : path.resolve(ctx.core.getWorkDir(), allowedFile);

        core.setMode('plan', resolvedPath);
        team.broadcastModeChange('plan');
        console.log(chalk.yellow('Plan mode activated.'));
        console.log(chalk.gray(`Allowed file: ${resolvedPath}`));
        console.log(chalk.gray('All other code changes are prohibited.'));
      } else {
        // Strict plan mode
        core.setMode('plan');
        team.broadcastModeChange('plan');
        console.log(chalk.yellow('Plan mode activated (strict).'));
        console.log(chalk.gray('All code changes are prohibited.'));
      }
    } else if (subcmd === 'off') {
      core.setMode('normal');
      team.broadcastModeChange('normal');
      console.log(chalk.green('Returned to normal mode.'));
      console.log(chalk.gray('Code changes are now allowed.'));
    } else {
      console.log(chalk.red(`Unknown option: ${subcmd}`));
      console.log(chalk.gray('Usage: /plan [on|off]'));
      console.log(chalk.gray('  /plan on         - Strict plan mode (no edits)'));
      console.log(chalk.gray('  /plan on <file>  - Plan mode with one allowed file'));
      console.log(chalk.gray('  /plan off        - Return to normal mode'));
    }
  },
};