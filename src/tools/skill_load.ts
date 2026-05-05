/**
 * skill_load.ts - Load a skill into context
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * This tool loads a skill by name and returns its content.
 * If no name is provided, uses semantic search to find relevant skills.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { loader } from '../context/shared/loader.js';
import { getSkillMatchThreshold } from '../config.js';

export const skillLoadTool: ToolDefinition = {
  name: 'skill_load',
  description: `Load a skill by name. Returns specialized knowledge and instructions. Use when you need guidance for specific tasks like code-review or coordination.

Two usage modes:
- With name: Load a specific skill by exact name (returns error if not found)
- Without name: Use semantic search to find relevant skills based on intent

Use this when:
- You need specialized knowledge for a task
- You're unsure how to approach a problem
- You want to discover relevant skills`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Optional: The exact name of the skill to load. If not provided, semantic search will be used to find relevant skills based on intent.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this skill is needed. This helps with semantic matching when the skill name is partial or unknown.',
      },
    },
    required: ['intent'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const skillName = args.name as string | undefined;
    const intent = args.intent as string;

    ctx.core.brief('info', 'skill_load', skillName || '<discovery>', intent);

    // Case 1: Name provided - try exact match
    if (skillName) {
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

      // No exact match found - instruct LLM to use intent-only mode
      return `ERROR: Skill '${skillName}' not found.

Do not guess skill names. Instead, call skill_load again without the 'name' parameter, providing only the 'intent' parameter to discover relevant skills.

Example: skill_load(intent="${intent}")`;
    }

    // Case 2: No name provided - use semantic search to find relevant skills
    try {
      const threshold = getSkillMatchThreshold();
      const searchQuery = `${intent} -- what specialist knowledge is required?`;
      const results = await ctx.wiki.get(searchQuery, { domain: 'skills', topK: 3, threshold });

      if (results.length === 0) {
        return 'ERROR: No skills found matching your intent.\n\nNo skills are currently available in the knowledge base. Skills may need to be loaded or indexed first.';
      }

      // Format suggestions with name and wiki content
      const suggestions = results.map(r => {
        const matchedName = r.document.title;
        const similarity = (r.similarity * 100).toFixed(0);
        return `## ${matchedName} (${similarity}% match)\n\n${r.document.content}`;
      }).join('\n\n---\n\n');

      return `Found ${results.length} skill(s) matching your intent:\n\n---\n\n${suggestions}\n\n---\n\nTo load a specific skill, use: skill_load(name="<skill_name>", intent="...")`;
    } catch (error) {
      // Semantic search failed (likely no embedding model)
      return 'ERROR: No skills found.\n\nSkill search is not available (embedding model may not be configured). Try providing a specific skill name if known.';
    }
  },
};