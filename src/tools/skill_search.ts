/**
 * skill_search.ts - Search skills by keywords with semantic and name matching
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * This tool searches for skills using a combination of:
 * 1. Semantic search via wiki (embedding-based)
 * 2. Name/keyword fuzzy matching against loaded skills
 *
 * Returns a list of matching skills with their names and descriptions.
 * Use skill_load(name="<exact_name>") to load a specific skill's full content.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { getSkillMatchThreshold } from '../config.js';

export const skillSearchTool: ToolDefinition = {
  name: 'skill_search',
  description: `Search skills by keywords. Returns a list of matching skill names and descriptions.

Use this when you don't know the exact skill name, or want to find relevant skills for a task.
Results include skills matched by semantic similarity and name/keyword matching.
Once you find the right skill, use skill_load(name="<exact_name>") to load its full content.`,
  input_schema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'REQUIRED: Short keywords/phrases (2-5 words) describing the skill you are looking for. Use concise terms, NOT full sentences or long descriptions.',
      },
    },
    required: ['search'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const search = args.search as string;

    // Validate search parameter
    if (!search || typeof search !== 'string' || search.trim() === '') {
      ctx.core.brief('error', 'skill_search', 'Missing or empty search parameter', 'skill_search(search="<keywords>")');
      return 'ERROR: The "search" parameter is required and must be a non-empty string.\n\nUsage: skill_search(search="<keywords about what you need>")';
    }

    const threshold = getSkillMatchThreshold();
    const searchQuery = `a skill to satisfy: ${search}`;
    let semResults: Awaited<ReturnType<typeof ctx.wiki.get>> = [];

    // Semantic search via wiki (embedding-based)
    try {
      semResults = await ctx.wiki.get(searchQuery, { domain: 'skills', topK: 3, threshold });
    } catch {
      // Semantic search may not be available (no embedding model)
    }

    // Name/keyword search: match search terms against skill names and keywords
    const nameResults: { name: string; description: string; keywords: string[] }[] = [];
    if (search.length > 2) {
      const lowerSearch = search.toLowerCase();
      const searchTerms = lowerSearch.split(/\s+/).filter(t => t.length > 1);
      const allSkills = ctx.skill.listSkills();
      for (const s of allSkills) {
        const nameMatch = searchTerms.some(term => s.name.toLowerCase().includes(term));
        const kwMatch = s.keywords.some(kw =>
          searchTerms.some(term => kw.toLowerCase().includes(term))
        );
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
        const desc = nr.description ? `*${nr.description}*` : '';
        const kw = nr.keywords.length > 0 ? `Keywords: ${nr.keywords.join(', ')}` : '';
        const parts = [desc, kw].filter(Boolean);
        suggestions.push(`## ${nr.name} (name/keyword match)\n\n${parts.join('\n')}`);
      }
    }

    if (suggestions.length === 0) {
      ctx.core.brief('warn', 'skill_search', `No matches: ${search}`);
      return `No skills found matching '${search}'.

Suggestions:
- Try different keywords (shorter, more focused terms)
- Use broader terms to describe the capability you need
- Some skills may not be indexed yet; try /skills build to rebuild the skill index.`;
    }

    const allNames = [...matchedNames];
    const matchSummary = allNames.join(', ');
    ctx.core.brief('info', 'skill_search', `→ ${matchSummary}`, search);

    const body = suggestions.join('\n\n---\n\n');

    return `Found ${suggestions.length} skill(s) matching '${search}':\n\n---\n\n${body}\n\n---\n\nTo load a specific skill, use: skill_load(name="<exact_skill_name>")`;
  },
};
