/**
 * /team command - Print team information
 */

import type { SlashCommand } from '../types.js';

export const teamCommand: SlashCommand = {
  name: 'team',
  description: 'Print team information',
  handler: (context) => {
    console.log(context.ctx.team.printTeam());
  },
};