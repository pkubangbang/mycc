/**
 * /compact command - Manually trigger conversation compaction
 *
 * Usage:
 *   /compact    - Trigger manual compaction
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually trigger conversation compaction',
  handler: async (context) => {
    console.log(chalk.cyan('\nTriggering manual compaction...\n'));

    // Cast triologue to access compact method
    const triologue = context.triologue as { compact: () => Promise<void> };

    try {
      await triologue.compact();
      console.log(chalk.green('Compaction complete.'));
      console.log(chalk.gray('The conversation has been summarized. Domains were included for knowledge persistence.'));
    } catch (err) {
      console.log(chalk.red(`Compaction failed: ${(err as Error).message}`));
    }
  },
};