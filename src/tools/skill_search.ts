/**
 * skill_search.ts - Search skills by keywords with positional scoring and
 *                   scope-aware semantic boost.
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents.
 *
 * CONSOLIDATION: this tool is the single skill-discovery entry point. It
 * shares the SAME keyword-extraction primitive (`extractKeywords` from
 * src/loop/keyword-extractor.ts) AND the SAME scorer (`scoreSkills` from
 * src/loop/skill-matcher.ts) as the proactive SkillSuggester
 * (src/loop/states/collect-skill.ts), so on-demand search and proactive
 * discovery agree on prompt, tool, result contract, AND scoring — no private
 * drift in either layer.
 *
 * API: skill_search(search, semantic?)
 *   arg1 `search`   — the query to extract keywords from (via retryChat +
 *                     the extract_keywords tool, tool_choice:'required').
 *                     The LLM emits significance-ORDERED keywords (most
 *                     discriminative first). These are matched positionally
 *                     against every loaded skill's keywords.
 *   arg2 `semantic` — optional semantic refinement string fed to
 *                     ctx.wiki.get (embedding similarity). When omitted, the
 *                     extractor's distilled `freeformQuery` is used (it is a
 *                     cleaner semantic phrase than the raw `search` arg); if
 *                     that is empty too, `search` is used. The resulting
 *                     similarity becomes a multiplicative BOOST on the
 *                     keyword points.
 *
 * SCORING (delegated to src/loop/skill-matcher.ts → scoreSkills):
 *   1. Positional points [10, 7, 5, 3, 2] for the 1st..5th significance-
 *      ordered query keyword (exact case-insensitive token membership; first
 *      5 only). points > 0 is the hard precondition (pure-semantic entry is
 *      impossible by construction — 0 × anything = 0).
 *   2. Scope-aware boost: similarity is matched by FULL qualified wiki title
 *      ("${scope}:${name}"), NOT the stripped bare name — so a cross-project
 *      same-named skill cannot inherit another scope's similarity (the P1
 *      scope-collision bug fixed in skill-matcher.ts). When sim > THRESHOLD,
 *      boost = 1 + (sim - THRESHOLD); otherwise boost = 1.0 (a keyword-
 *      matched skill missing the semantic window is NEVER excluded — e.g.
 *      12 × 1.0 = 12, still suggested).
 *   3. score = points × boost; keep score > 10 STRICT; sort desc; top 3.
 *
 * topK for ctx.wiki.get is a FLAT 50 (see skill-matcher.ts SKILL_SEMANTIC_TOPK
 * for why this is flat and not derived from listSkills().length). A saturated
 * window (results.length === topK) is logged via ctx.core.brief so the
 * operator can raise the cap or revive the (held) getExact design.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { extractKeywords } from '../loop/keyword-extractor.js';
import {
  scoreSkills,
  SKILL_SEMANTIC_TOPK,
  getSkillMatchThreshold,
} from '../loop/skill-matcher.js';
import { loader } from '../context/shared/loader.js';

export const skillSearchTool: ToolDefinition = {
  name: 'skill_search',
  description: `Search skills by keywords. Returns a ranked list of matching skill names and descriptions.

Use this when you don't know the exact skill name, or want to find relevant skills for a task.
The first argument is a natural-language query: keywords are extracted from it (via an LLM call) and matched positionally against every loaded skill's keywords. The optional second argument is a semantic refinement string; its embedding similarity boosts the keyword-match score.
Results are ranked by a combined score (keyword points × semantic boost); only the top matches are returned.
Once you find the right skill, use skill_load(name="<exact_name>") to load its full content.`,
  input_schema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'REQUIRED: A natural-language query (a few words or a short phrase) describing the skill you are looking for, in any language. Keywords are extracted from this via an LLM and matched against skill keywords. Use concise terms, NOT long essays.',
      },
      semantic: {
        type: 'string',
        description: 'OPTIONAL: A semantic refinement string whose embedding similarity boosts the keyword-match score. When omitted, the extractor\'s distilled free-form query is used for the semantic lookup (falling back to `search` if that is empty). Useful when the natural-language query and the precise semantic phrase differ.',
      },
    },
    required: ['search'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const search = args.search as string;
    const semantic = (args.semantic as string | undefined) ?? undefined;

    // Validate the search parameter.
    if (!search || typeof search !== 'string' || search.trim() === '') {
      ctx.core.brief('error', 'skill_search', 'Missing or empty search parameter', 'skill_search(search="<query>")');
      return 'ERROR: The "search" parameter is required and must be a non-empty string.\n\nUsage: skill_search(search="<query about what you need>")';
    }

    // Extract significance-ordered keywords from the query via the shared
    // LLM extractor (retryChat + extract_keywords tool, tool_choice required).
    // A `failed`/`skipped` outcome yields no keywords → no scoreboard entries
    // → the tool reports no matches (pure-semantic entry is impossible by
    // construction: points>0 is the hard precondition).
    const extraction = await extractKeywords(search, loader.getSkillKeywords());
    const keywords = extraction.status === 'success' ? extraction.keywords : [];

    // The semantic query for ctx.wiki.get. Precedence: an explicit `semantic`
    // arg; else the extractor's distilled freeformQuery (a cleaner semantic
    // phrase than the raw search arg); else the raw `search` arg as the last
    // resort. (The tool description documents this precedence — it is NOT a
    // simple `semantic || search` default.)
    const semanticQuery =
      (semantic && semantic.trim()) ||
      (extraction.status === 'success' && extraction.freeformQuery) ||
      search;

    const threshold = getSkillMatchThreshold();

    // Semantic search via wiki (embedding-based). Graceful failure: if the
    // wiki call throws (no embedding model, transient error), pass an empty
    // result set to scoreSkills → boost defaults to 1.0 for every skill and
    // the keyword points alone still rank results.
    let semResults: Awaited<ReturnType<typeof ctx.wiki.get>> = [];
    try {
      semResults = await ctx.wiki.get(semanticQuery, {
        domain: 'skills',
        topK: SKILL_SEMANTIC_TOPK,
        threshold,
      });
      // Saturated-window signal: if the returned count equals topK, the
      // domain may have more qualifying rows than the cap allows through —
      // a future signal to raise the cap or revive the (held) getExact design.
      if (semResults.length === SKILL_SEMANTIC_TOPK) {
        ctx.core.brief(
          'warn',
          'skill_search',
          `semantic window saturated (topK=${SKILL_SEMANTIC_TOPK}); results may be truncated`,
          semanticQuery,
        );
      }
    } catch {
      // Semantic search unavailable → scoreSkills receives [] → boost 1.0.
    }

    // Shared scorer: positional keyword points × scope-aware semantic boost.
    // Returns the top SKILL_TOP_N ranked candidates (score > floor STRICT).
    const kept = scoreSkills({
      skills: ctx.skill.listSkills(),
      keywords,
      semanticResults: semResults,
      threshold,
    });

    if (kept.length === 0) {
      ctx.core.brief('warn', 'skill_search', `No matches: ${search}`);
      return `No skills found matching '${search}'.

Suggestions:
- Try different keywords (shorter, more focused terms)
- Use broader terms to describe the capability you need
- Some skills may not be indexed yet; try /skills build to rebuild the skill index.`;
    }

    // Render. Show the score (keyword points × boost) and, when a similarity
    // was found, the percentage. Description + keywords aid the user's pick.
    const suggestions: string[] = [];
    for (const r of kept) {
      const pct = r.similarity !== undefined ? ` · ${Math.round(r.similarity * 100)}% semantic` : '';
      const boostTag = r.boost > 1.0 ? ` · x${r.boost.toFixed(2)} boost` : '';
      const desc = r.skill.description ? `*${r.skill.description}*` : '';
      const kw = r.skill.keywords.length > 0 ? `Keywords: ${r.skill.keywords.join(', ')}` : '';
      const parts = [desc, kw].filter(Boolean);
      suggestions.push(
        `## ${r.skill.name} (score ${r.score} · pts ${r.points}${boostTag}${pct})\n\n${parts.join('\n')}`,
      );
    }

    const names = kept.map(r => r.skill.name).join(', ');
    ctx.core.brief('info', 'skill_search', `→ ${names}`, search);

    const body = suggestions.join('\n\n---\n\n');

    return `Found ${kept.length} skill(s) matching '${search}':\n\n---\n\n${body}\n\n---\n\nTo load a specific skill, use: skill_load(name="<exact_skill_name>")`;
  },
};