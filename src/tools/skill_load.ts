/**
 * skill_load.ts - Load a skill by exact name
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * This tool loads a skill by its exact name and returns its full content.
 * It performs strict exact matching - no fuzzy search or fallback.
 * For fuzzy/keyword search, use skill_search instead.
 *
 * IMPORTANT: The 'name' parameter is REQUIRED for this tool.
 * If you are unsure of the exact name, use skill_search first to find it.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { loader } from '../context/shared/loader.js';

export const skillLoadTool: ToolDefinition = {
  name: 'skill_load',
  description: `Load a skill by exact name. Returns the full skill content.

IMPORTANT: You MUST provide the 'name' parameter with the exact skill name. This tool does NOT do fuzzy search.
If you don't know the exact name, use skill_search with keywords to find relevant skills first.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'REQUIRED: The exact name of the skill to load. Must match exactly (case-sensitive).',
      },
      search: {
        type: 'string',
        description: 'Deprecated - has no effect on exact name matching. Use skill_search tool for searching.',
      },
    },
    required: ['name'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const skillName = args.name as string;

    // Validate that name is provided
    if (!skillName || typeof skillName !== 'string' || skillName.trim() === '') {
      ctx.core.brief('error', 'skill_load', 'Missing or empty name parameter', 'Use skill_load(name="<exact_skill_name>")');
      return 'ERROR: The "name" parameter is required and must be a non-empty string.\n\nUsage: skill_load(name="<exact_skill_name>")\nFor fuzzy search, use: skill_search(search="<keywords>")';
    }

    // Attempt exact name match (case-sensitive)
    const skill = ctx.skill.getSkill(skillName);
    if (!skill) {
      ctx.core.brief('warn', 'skill_load', `Skill not found: ${skillName}`);
      return `ERROR: Skill '${skillName}' not found by exact name.

To find the correct skill name, use:
  skill_search(search="<keywords related to what you need>")

Once you find the correct name, load it with:
  skill_load(name="<exact_skill_name>")`;
    }

    ctx.core.brief('info', 'skill_load', `Loaded: ${skillName}`);

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
  },
};
