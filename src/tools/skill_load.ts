/**
 * skill_load.ts - Load a skill by exact name
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * This tool loads a skill by its exact name and returns its full content.
 * It first tries strict exact matching, then falls back to fuzzy matching
 * (ignoring case, hyphens, and underscores) before reporting "not found".
 * For keyword/fuzzy search, use skill_search instead.
 *
 * IMPORTANT: The 'name' parameter is REQUIRED for this tool.
 * If you are unsure of the exact name, use skill_search first to find it.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { loader } from '../context/shared/loader.js';
import { getSkillAbsolutePath } from '../utils/skill-path-resolver.js';

export const skillLoadTool: ToolDefinition = {
  name: 'skill_load',
  description: `Load a skill by exact name. Returns the full skill content. Minor variations (case, hyphens vs underscores) are auto-corrected. If you don't know the exact name, use skill_search first.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'REQUIRED: The exact name of the skill to load. Must match exactly (case-sensitive).',
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
    let skill = ctx.skill.getSkill(skillName);
    
    // If exact match fails, try fuzzy matching (normalize case, hyphens, underscores)
    if (!skill) {
      const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
      const targetKey = normalize(skillName);
      const allSkills = ctx.skill.listSkills();
      const fuzzyMatch = allSkills.find(s => normalize(s.name) === targetKey);
      if (fuzzyMatch) {
        skill = ctx.skill.getSkill(fuzzyMatch.name);
        if (skill) {
          ctx.core.brief('warn', 'skill_load', `Auto-corrected: "${skillName}" → "${skill.name}"`);
        }
      }
    }
    if (!skill) {
      ctx.core.brief('warn', 'skill_load', `Skill not found: ${skillName}`);
      return `ERROR: Skill '${skillName}' not found by exact name.

To find the correct skill name, use:
  skill_search(search="<keywords related to what you need>")

Once you find the correct name, load it with:
  skill_load(name="<exact_skill_name>")`;
    }

    // Retrospect: show the skill's location and level
    const layer = loader.getSkillLayer(skillName) || 'project';
    const levelLabel = layer.toUpperCase();
    const absPath = skill.sourceFile
      ? getSkillAbsolutePath(skill.sourceFile) || skill.sourceFile
      : 'unknown';
    ctx.core.brief('info', 'skill_load', `Loaded: ${skillName} (${levelLabel} — ${absPath})`);

    // Try to re-index skill to wiki (best effort, may fail if no embedding model)
    try {
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
