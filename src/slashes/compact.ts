/**
 * /compact command - Manually trigger conversation compaction
 *
 * Usage:
 *   /compact           - Trigger manual compaction
 *   /compact <focus>  - Compact with focus topic (e.g., /compact mindmap design)
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually trigger conversation compaction (/compact [focus])',
  handler: async (context) => {
    const query = context.query;
    
    // Parse optional focus topic: /compact <focus>
    const match = query.match(/^\/compact\s+(.+)$/);
    const focus = match ? match[1].trim() : undefined;

    if (focus) {
      console.log(chalk.cyan(`\nTriggering manual compaction with focus: "${focus}"...\n`));
    } else {
      console.log(chalk.cyan('\nTriggering manual compaction...\n'));
    }

    // Cast triologue to access compact method with optional focus
    const triologue = context.triologue as { compact: (focus?: string) => Promise<void> };

    try {
      await triologue.compact(focus);
      if (focus) {
        console.log(chalk.green(`Compaction complete (focus: ${focus}).`));
      } else {
        console.log(chalk.green('Compaction complete.'));
      }
      console.log(chalk.gray('The conversation has been summarized. Domains were included for knowledge persistence.'));
    } catch (err) {
      console.log(chalk.red(`Compaction failed: ${(err as Error).message}`));
    }
  },
};