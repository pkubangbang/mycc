/**
 * /skills command - Print available skills
 */

import type { SlashCommand } from '../types.js';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Print available skills',
  handler: (context) => {
    console.log(context.ctx.skill.printSkills());
  },
};