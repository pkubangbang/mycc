/**
 * /mode command - Manual mode control for the parent process
 *
 * Usage:
 *   /mode        - Display current mode
 *   /mode plan   - Change to plan mode (code changes prohibited)
 *   /mode normal - Change to normal mode (code changes allowed)
 */

import type { SlashCommand } from '../types.js';
import { Core } from '../context/parent/core.js';
import chalk from 'chalk';

export const modeCommand: SlashCommand = {
  name: 'mode',
  description: 'View or change agent mode (plan/normal)',
  handler: (context) => {
    const { args, ctx } = context;
    const core = ctx.core as Core;

    // No args: display current mode
    if (args.length <= 1) {
      const currentMode = core.getMode();
      const modeDisplay = currentMode === 'plan' ? chalk.yellow('PLAN') : chalk.green('NORMAL');
      console.log(`Currently in ${modeDisplay} mode.`);
      return;
    }

    // Get the mode argument
    const modeArg = args[1].toLowerCase();

    if (modeArg === 'plan') {
      core.setMode('plan');
      console.log(chalk.yellow('Mode changed to PLAN.'));
      console.log(chalk.gray('Code changes are now prohibited.'));
    } else if (modeArg === 'normal') {
      core.setMode('normal');
      console.log(chalk.green('Mode changed to NORMAL.'));
      console.log(chalk.gray('Code changes are now allowed.'));
    } else {
      console.log(chalk.red(`Unknown mode: ${modeArg}`));
      console.log(chalk.gray('Usage: /mode [plan|normal]'));
    }
  },
};