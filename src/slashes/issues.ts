/**
 * /issues command - List or show issues
 *
 * Usage:
 *   /issues       - List all issues
 *   /issues <id>  - Show specific issue details
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const issuesCommand: SlashCommand = {
  name: 'issues',
  description: 'List issues or show specific issue (/issues [id])',
  handler: async (context) => {
    const args = context.args;

    if (args.length > 1) {
      // Show specific issue details
      const issueId = parseInt(args[1], 10);
      if (isNaN(issueId)) {
        console.log(chalk.yellow(`Invalid issue ID: ${args[1]}`));
      } else {
        console.log(await context.ctx.issue.printIssue(issueId));
      }
    } else {
      // Show all issues
      console.log(await context.ctx.issue.printIssues());
    }
  },
};