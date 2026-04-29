/**
 * /mode command - View or change session mode
 *
 * Usage:
 *   /mode         - Show current mode
 *   /mode plan    - Switch to plan mode (blocks code changes)
 *   /mode normal  - Switch to normal mode (allows code changes)
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const modeCommand: SlashCommand = {
  name: 'mode',
  description: 'View or change session mode (plan/normal)',
  handler: (context) => {
    const args = context.args;
    const ctx = context.ctx;

    // No argument - show current mode
    if (args.length === 0) {
      const currentMode = ctx.core.getMode();
      console.log(chalk.cyan('\n=== Session Mode ===\n'));
      console.log(`Current mode: ${chalk.yellow(currentMode)}`);
      console.log();
      if (currentMode === 'plan') {
        console.log(chalk.yellow('Plan mode is active.'));
        console.log(chalk.gray('Code modifications are BLOCKED:'));
        console.log(chalk.gray('  - edit_file, write_file'));
        console.log(chalk.gray('  - git_commit'));
        console.log(chalk.gray('  - tm_create'));
        console.log();
        console.log(chalk.green('Use /mode normal to enable code changes.'));
      } else {
        console.log(chalk.green('Normal mode is active.'));
        console.log(chalk.gray('All tools are available.'));
        console.log();
        console.log(chalk.yellow('Use /mode plan to block code changes during planning.'));
      }
      console.log();
      return;
    }

    // Parse mode argument
    const mode = args[0].toLowerCase();

    if (mode !== 'plan' && mode !== 'normal') {
      console.log(chalk.red(`Invalid mode: ${mode}`));
      console.log(chalk.gray('Valid modes: plan, normal'));
      console.log();
      console.log(chalk.gray('  /mode plan   - Block code changes'));
      console.log(chalk.gray('  /mode normal - Allow code changes'));
      return;
    }

    const previousMode = ctx.core.getMode();
    ctx.core.setMode(mode as 'plan' | 'normal');

    console.log(chalk.cyan('\n=== Mode Changed ===\n'));
    console.log(`Previous: ${chalk.gray(previousMode)}`);
    console.log(`Current:  ${chalk.yellow(mode)}`);
    console.log();

    if (mode === 'plan') {
      console.log(chalk.yellow('Plan mode is now active.'));
      console.log(chalk.gray('Code modifications are BLOCKED.'));
      console.log();
      console.log(chalk.gray('Use /mode normal or mode_set({ mode: "normal" }) to enable code changes.'));
    } else {
      console.log(chalk.green('Normal mode is now active.'));
      console.log(chalk.gray('All tools are available.'));
      console.log();
      console.log(chalk.gray('Use /mode plan or mode_set({ mode: "plan" }) to block code changes.'));
    }
    console.log();
  },
};