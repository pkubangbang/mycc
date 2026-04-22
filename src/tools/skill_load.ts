/**
 * skill_load.ts - Load a skill into context
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * This tool loads a skill by name and returns its content.
 * Skills are stored as markdown files in .mycc/skills/
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { loader } from '../context/index.js';

export const skillLoadTool: ToolDefinition = {
  name: 'skill_load',
  description: 'Load a skill by name. Returns specialized knowledge and instructions. Use when you need guidance for specific tasks like code-review or coordination.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The name of the skill to load',
      },
    },
    required: ['name'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const skillName = args.name as string;

    ctx.core.brief('info', 'skill_load', skillName);

    const skill = ctx.skill.getSkill(skillName);

    if (!skill) {
      // List available skills if skill not found
      const availableSkills = ctx.skill.listSkills();
      if (availableSkills.length === 0) {
        return `Skill '${skillName}' not found. No skills are currently loaded.`;
      }
      const skillList = availableSkills.map(s => `  - ${s.name}: ${s.description}`).join('\n');
      return `Skill '${skillName}' not found. Available skills:\n${skillList}`;
    }

    // Verify-then-update: re-index skill to wiki if content changed
    const layer = loader.getSkillLayer(skillName) || 'project';
    await loader.indexSkillToWiki(skill, ctx.wiki, layer);

    // Return the full skill content
    const header = `# Skill: ${skill.name}\n`;
    const description = skill.description ? `Description: ${skill.description}\n\n` : '';
    const keywords = skill.keywords.length > 0 ? `Keywords: ${skill.keywords.join(', ')}\n\n` : '';

    return `${header + description + keywords  }---\n\n${  skill.content}`;
  },
};