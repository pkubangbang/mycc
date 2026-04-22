/**
 * /skills command - Manage skills
 *
 * Usage:
 *   /skills          - List available skills
 *   /skills build    - Rebuild wiki index for semantic skill matching
 */

import type { SlashCommand } from '../types.js';
import { loader } from '../context/index.js';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Manage skills - list skills, rebuild wiki index',
  handler: async (context) => {
    const { args, ctx } = context;

    if (args[0] === 'build') {
      // Index all skills to wiki
      await loader.indexAllSkillsToWiki(ctx.wiki);
      console.log('Skills rebuilt and indexed in wiki.');
      return;
    }

    // Default: list skills
    console.log(ctx.skill.printSkills());
  },
};