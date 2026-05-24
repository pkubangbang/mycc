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
  description: `Load a skill by name, or search skills by keywords. Returns specialized knowledge and instructions.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Optional: The exact name of the skill to load. If not provided, semantic search will be used to find relevant skills based on search keywords.',
      },
      search: {
        type: 'string',
        description: 'REQUIRED: Short keywords/phrases (2-5 words) describing what you are looking for. Use concise terms, NOT full sentences or long descriptions.',
      },
    },
    required: ['search'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const skillName = args.name as string | undefined;
    const search = args.search as string;

    // Try exact name match first
    if (skillName) {
      const skill = ctx.skill.getSkill(skillName);
      if (skill) {
        ctx.core.brief('info', 'skill_load', `Loaded: ${skillName}`, search);

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
    }

    // No exact match (or no name) → union semantic + name/keyword search
    const threshold = getSkillMatchThreshold();
    const searchQuery = `a skill to satisfy: ${search}`;
    let semResults: Awaited<ReturnType<typeof ctx.wiki.get>> = [];

    // Semantic search by search keywords
    try {
      semResults = await ctx.wiki.get(searchQuery, { domain: 'skills', topK: 3, threshold });
    } catch {
      // Semantic search may not be available
    }

    // Name/keyword search: match the name param against skill names and keywords
    const nameResults: { name: string; description: string; keywords: string[] }[] = [];
    if (skillName && skillName.length > 3) {
      const lowerName = skillName.toLowerCase();
      const allSkills = ctx.skill.listSkills();
      for (const s of allSkills) {
        const nameMatch = s.name.toLowerCase().includes(lowerName);
        const kwMatch = s.keywords.some(kw => kw.toLowerCase().includes(lowerName));
        if (nameMatch || kwMatch) {
          nameResults.push({ name: s.name, description: s.description, keywords: s.keywords });
        }
      }
    }

    // Deduplicate and build suggestions
    const matchedNames = new Set<string>();
    const suggestions: string[] = [];

    for (const r of semResults) {
      if (!matchedNames.has(r.document.title)) {
        matchedNames.add(r.document.title);
        const pct = (r.similarity * 100).toFixed(0);
        suggestions.push(`## ${r.document.title} (${pct}% semantic match)\n\n${r.document.content}`);
      }
    }

    for (const nr of nameResults) {
      if (!matchedNames.has(nr.name)) {
        matchedNames.add(nr.name);
        const desc = nr.description ? `\n*${nr.description}*` : '';
        const kw = nr.keywords.length > 0 ? `\nKeywords: ${nr.keywords.join(', ')}` : '';
        suggestions.push(`## ${nr.name} (name/keyword match)\n\n${desc}\n${kw}`.trim());
      }
    }

    if (suggestions.length === 0) {
      const label = skillName || search;
      ctx.core.brief('warn', 'skill_load', `No matches: ${label}`, search);
      return `ERROR: No skills found matching '${label}'.\n\nNo skills are currently available in the knowledge base. Skills may need to be loaded or indexed first. Try /skills build to rebuild the skill index.`;
    }

    const allNames = [...matchedNames];
    const matchSummary = allNames.join(', ');
    ctx.core.brief('info', 'skill_load', `→ ${matchSummary}`, search);

    const body = suggestions.join('\n\n---\n\n');

    if (skillName) {
      return `Skill '${skillName}' not found exactly, but found ${suggestions.length} suggestion(s):\n\n---\n\n${body}\n\n---\n\nTo load a specific skill, use: skill_load(name="<skill_name>", search="<keywords>")`;
    }

    return `Found ${suggestions.length} skill(s) matching your search:\n\n---\n\n${body}\n\n---\n\nTo load a specific skill, use: skill_load(name="<skill_name>", search="<keywords>")`;
  },
};