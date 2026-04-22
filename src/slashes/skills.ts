/**
 * /skills command - Manage skills
 *
 * Usage:
 *   /skills          - List available skills
 *   /skills build    - Rebuild wiki index for semantic skill matching
 */

import chalk from 'chalk';
import type { SlashCommand } from '../types.js';
import { loader } from '../context/shared/loader.js';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Manage skills - list skills, rebuild wiki index',
  aliases: ['skill'],
  handler: async (context) => {
    const { args, ctx } = context;

    if (args[1] === 'build') {
      // Index all skills to wiki
      await loader.indexAllSkillsToWiki(ctx.wiki);
      console.log(chalk.green('✓') + ' Skills rebuilt and indexed in wiki.');
      return;
    }

    // Default: list skills
    const skills = loader.listSkills();
    if (skills.length === 0) {
      console.log(chalk.yellow('No skills loaded.'));
      return;
    }

    console.log('');
    console.log(chalk.bold('Available Skills'));
    console.log(chalk.dim('─'.repeat(50)));

    for (const skill of skills) {
      // Skill name in cyan
      console.log(chalk.cyan.bold(`${skill.name}`));
      // Description in dim
      console.log(chalk.dim(`${skill.description}`));
      // Keywords emphasized in yellow
      if (Array.isArray(skill.keywords) && skill.keywords.length > 0) {
        console.log(chalk.yellow(`Keywords: ${skill.keywords.join(', ')}`));
      }
      console.log('');
    }

    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.dim('Use ') + chalk.green('/skill build') + chalk.dim(' to build skill wiki-db.'));
    console.log('');
  },
};