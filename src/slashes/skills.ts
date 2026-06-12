/**
 * /skills command - Manage skills
 *
 * Usage:
 *   /skills          - List available skills
 *   /skills build    - Reload skills from disk and rebuild wiki index
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
      // Reload skills from disk to pick up newly added skills, then index to wiki
      loader.loadSkills();
      await loader.indexAllSkillsToWiki(ctx.wiki);
      console.log(`${chalk.green('✓')} Skills reloaded and indexed in wiki.`);
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
      // When to use (trigger) in green
      if (skill.when) {
        console.log(chalk.green(`When: ${skill.when}`));
      }
      // Keywords emphasized in yellow
      if (Array.isArray(skill.keywords) && skill.keywords.length > 0) {
        console.log(chalk.yellow(`Keywords: ${skill.keywords.join(', ')}`));
      }
      console.log('');
    }

    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.dim('Skills are auto-indexed at startup. Use ') + chalk.green('/skill build') + chalk.dim(' to reload and re-index after adding new skills.'));
    console.log('');
  },
};