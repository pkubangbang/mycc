/**
 * skill_load.ts - Load a skill into context
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * This tool loads a skill by name and returns its content.
 * Supports discovery mode: pass name="list" to see all skills.
 * Supports semantic search: pass partial name to find similar skills.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { loader } from '../context/shared/loader.js';
import { getSkillMatchThreshold } from '../config.js';

export const skillLoadTool: ToolDefinition = {
  name: 'skill_load',
  description: `Load a skill by name. Returns specialized knowledge and instructions. Use when you need guidance for specific tasks like code-review or coordination.

Discovery modes:
- name="list" - Show all available skills
- partial name - Search for similar skills using semantic matching (provide clear intent for better results)

Use this when:
- You need specialized knowledge for a task
- You're unsure how to approach a problem
- You want to see what skills are available`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The name of the skill to load, or "list" to see all skills',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this skill is needed. This helps with semantic matching when the skill name is partial or unknown.',
      },
    },
    required: ['name', 'intent'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const skillName = args.name as string;
    const intent = args.intent as string;

    ctx.core.brief('info', 'skill_load', skillName, intent);

    // Discovery mode: list all skills
    if (skillName === 'list' || skillName === '*') {
      const skills = ctx.skill.listSkills();
      if (skills.length === 0) {
        return 'No skills are currently loaded.';
      }
      const skillList = skills.map(s => {
        const keywords = s.keywords.length > 0 ? ` (keywords: ${s.keywords.join(', ')})` : '';
        const when = s.when ? ` Triggers on: ${s.when}` : '';
        return `  - **${s.name}**: ${s.description}${keywords}${when}`;
      }).join('\n');
      return `Available skills:\n\n${skillList}\n\nUse skill_load(name="<skill_name>", intent="...") to load a specific skill.`;
    }

    // Exact match
    const skill = ctx.skill.getSkill(skillName);
    if (skill) {
      // Try to re-index skill to wiki (best effort, may fail if no embedding model)
      try {
        const layer = loader.getSkillLayer(skillName) || 'project';
        await loader.indexSkillToWiki(skill, ctx.wiki, layer);
      } catch {
        // Ignore indexing errors - skill content is still valid
      }

      // Return the full skill content
      const header = `# Skill: ${skill.name}\n`;
      const description = skill.description ? `Description: ${skill.description}\n\n` : '';
      const keywords = skill.keywords.length > 0 ? `Keywords: ${skill.keywords.join(', ')}\n\n` : '';
      const when = skill.when ? `When: ${skill.when}\n\n` : '';

      return `${header}${description}${keywords}${when}---\n\n${skill.content}`;
    }

    // No exact match: try semantic search using intent for better matching
    try {
      const threshold = getSkillMatchThreshold();
      const searchQuery = `${intent} -- what specialist knowledge is required?`;
      const results = await ctx.wiki.get(searchQuery, { domain: 'skills', topK: 3, threshold });

      if (results.length > 0) {
        const suggestions = results.map(r => {
          const matchedName = r.document.title;
          const desc = r.document.content.split('\n').find(line => line.startsWith('Description:'))?.replace('Description: ', '') || '';
          const similarity = (r.similarity * 100).toFixed(0);
          return `  - **${matchedName}** (${similarity}% match): ${desc}`;
        }).join('\n');

        // Check if any result matches case-insensitively
        const exactResult = results.find(r => r.document.title.toLowerCase() === skillName.toLowerCase());
        if (exactResult) {
          const matchedSkill = ctx.skill.getSkill(exactResult.document.title);
          if (matchedSkill) {
            const header = `# Skill: ${matchedSkill.name}\n`;
            const description = matchedSkill.description ? `Description: ${matchedSkill.description}\n\n` : '';
            const keywords = matchedSkill.keywords.length > 0 ? `Keywords: ${matchedSkill.keywords.join(', ')}\n\n` : '';
            const when = matchedSkill.when ? `When: ${matchedSkill.when}\n\n` : '';
            return `${header}${description}${keywords}${when}---\n\n${matchedSkill.content}`;
          }
        }

        return `No exact match for '${skillName}'. Similar skills based on intent:\n\n${suggestions}\n\nUse skill_load(name="<skill_name>", intent="...") to load a specific skill.`;
      }
    } catch {
      // Semantic search failed (likely no embedding model) - fall through to list available skills
    }

    // No matches or semantic search failed: show available skills
    const availableSkills = ctx.skill.listSkills();
    if (availableSkills.length === 0) {
      return `Skill '${skillName}' not found. No skills are currently loaded.`;
    }
    const skillList = availableSkills.map(s => `  - ${s.name}: ${s.description}`).join('\n');
    return `Skill '${skillName}' not found. Available skills:\n${skillList}\n\nUse skill_load(name="list", intent="...") to see all skills with keywords.`;
  },
};