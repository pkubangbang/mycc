/**
 * skill_search.ts - Search skills by keywords with positional scoring and
 *                   semantic boost.
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents.
 *
 * CONSOLIDATION: this tool is the single skill-discovery entry point. The
 * proactive SkillSuggester (src/loop/states/collect-skill.ts) reuses the
 * SAME shared keyword-extraction primitive (`extractKeywords` from
 * src/loop/keyword-extractor.ts) so discovery and on-demand search agree on
 * prompt, tool, and result contract — no private drift.
 *
 * API: skill_search(search, semantic?)
 *   arg1 `search`   — the query to extract keywords from (via retryChat +
 *                     the extract_keywords tool, tool_choice:'required').
 *                     The LLM emits significance-ORDERED keywords (most
 *                     discriminative first). These are matched positionally
 *                     against every loaded skill's keywords.
 *   arg2 `semantic` — optional semantic refinement string fed to
 *                     ctx.wiki.get (embedding similarity). Defaults to the
 *                     `search` query when omitted. The resulting similarity
 *                     becomes a multiplicative BOOST on the keyword points.
 *
 * SCORING (see the shared pinned scoring contract):
 *   1. Scoreboard: for each significance-ordered query keyword kw[i], every
 *      skill that owns kw[i] (exact case-insensitive token membership) earns
 *      WEIGHTS[i] points. Only the first 5 keywords score
 *      ([10, 7, 5, 3, 2]); keywords beyond the 5th are ignored.
 *   2. Boost: for each scoreboard entry, look up its wiki similarity (title
 *      match against ctx.wiki.get results). When sim > THRESHOLD,
 *      boost = 1 + (sim - THRESHOLD); otherwise boost = 1.0 (a keyword-
 *      matched skill that misses the semantic window is NEVER excluded — it
 *      keeps its raw points, the user's worked example: 12 x 1.0 = 12).
 *   3. score = points * boost.
 *   4. Gate: keep score > 10 STRICT; points > 0 is a HARD precondition
 *      (0 * anything = 0, so a pure-semantic skill can never surface — arg2
 *      alone must never return a skill).
 *   5. Order: sort by score desc, return the top SKILL_TOP_N (3).
 *
 * topK for ctx.wiki.get is a FLAT 50 (NOT derived from listSkills().length).
 * The 'skills' wiki domain is SHARED ACROSS PROJECTS and accumulates rows
 * from every project on the machine (the loader's orphan sweep is own-scope
 * only, so other projects' rows survive). listSkills().length is therefore
 * NOT an upper bound on the domain row count. Measured on a 66-row domain,
 * topK=50 yields 0 hidden results. Residual risk: if the domain grows enough
 * that 50 starts truncating, results.length === topK (a saturated window) is
 * the signal — logged via ctx.core.brief so the operator can raise the cap
 * or revive the (held) getExact design.
 */

import type { ToolDefinition, AgentContext, Skill } from '../types.js';
import { getSkillMatchThreshold } from '../config.js';
import { loader } from '../context/shared/loader.js';
import { extractKeywords } from '../loop/keyword-extractor.js';

/**
 * Positional weights for the 1st..5th significance-ordered query keyword.
 * The 1st (most discriminative) keyword is worth 10; the 5th is worth 2.
 * Keywords beyond the 5th are ignored by the scorer.
 */
const KEYWORD_WEIGHTS = [10, 7, 5, 3, 2] as const;

/** Number of skills to return (top-N after scoring + sorting). */
const SKILL_TOP_N = 3;

/**
 * FLAT topK for the semantic wiki.get call. See the module header for why
 * this is a flat constant and not derived from listSkills().length.
 */
const SKILL_SEMANTIC_TOPK = 50;

/** Minimum total score to surface a skill (STRICT greater-than). */
const SKILL_SCORE_FLOOR = 10;

/**
 * Strip the "<scope>:" prefix from a wiki skill title to get the bare skill
 * name. Wiki titles use the format "<scope>:<skill-name>" (e.g.
 * "project:code-review"); a title without a colon is returned as-is. Mirrors
 * the logic in collect-skill.ts so the two consumers map wiki titles
 * identically.
 */
function baseSkillNameFromWikiTitle(title: string): string {
  return title.includes(':') ? title.split(':').slice(1).join(':') : title;
}

/**
 * Build the keyword→skills index for a single search pass: for every loaded
 * skill, register the skill under each of its (lowercased) keywords so a
 * query keyword can be looked up in O(1). A skill with duplicate keywords
 * registers once per keyword (Set semantics on the keyword side).
 *
 * Returns a Map<lowercasedKeyword, Skill[]> — the "skillInventory" the
 * scoreboard iterates. Building it once per call (not per query keyword)
 * keeps the scoreboard a single linear pass over the query keywords.
 */
function buildKeywordIndex(skills: Skill[]): Map<string, Skill[]> {
  const index = new Map<string, Skill[]>();
  for (const skill of skills) {
    for (const kw of skill.keywords) {
      const key = kw.toLowerCase();
      const bucket = index.get(key);
      if (bucket) {
        bucket.push(skill);
      } else {
        index.set(key, [skill]);
      }
    }
  }
  return index;
}

/**
 * Run the keyword-extraction + positional-points scoreboard. For each
 * significance-ordered query keyword kw[i] (i < 5), every skill that owns
 * kw[i] earns KEYWORD_WEIGHTS[i] points. Returns the scoreboard keyed by
 * skill name (the last write of a skill's vector wins, but points accumulate).
 *
 * `keywords` is already lowercased + significance-ordered by extractKeywords.
 * Keywords beyond index 4 are ignored (only the first 5 carry weight).
 */
function scoreByKeywords(
  keywords: string[],
  index: Map<string, Skill[]>,
): Map<string, { skill: Skill; points: number }> {
  const scoreboard = new Map<string, { skill: Skill; points: number }>();
  for (let i = 0; i < keywords.length; i++) {
    if (i >= KEYWORD_WEIGHTS.length) break; // only first 5 score
    const kw = keywords[i];
    const found = index.get(kw);
    if (!found) continue;
    const weight = KEYWORD_WEIGHTS[i];
    for (const skill of found) {
      const entry = scoreboard.get(skill.name);
      if (entry) {
        entry.points += weight;
      } else {
        scoreboard.set(skill.name, { skill, points: weight });
      }
    }
  }
  return scoreboard;
}

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
        description: 'OPTIONAL: A semantic refinement string whose embedding similarity boosts the keyword-match score. Defaults to the `search` query when omitted. Useful when the natural-language query and the precise semantic phrase differ.',
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

    // The semantic query: fall back to the `search` arg when `semantic` is
    // absent, then to the extractor's freeformQuery when the search arg is
    // too short for a useful embedding phrase.
    const semanticQuery =
      (semantic && semantic.trim()) ||
      (extraction.status === 'success' && extraction.freeformQuery) ||
      search;

    const threshold = getSkillMatchThreshold();

    // Semantic search via wiki (embedding-based). Graceful failure: if the
    // wiki call throws (no embedding model, transient error), boost defaults
    // to 1.0 for every skill — the keyword points alone still rank results.
    let semResults: Awaited<ReturnType<typeof ctx.wiki.get>> = [];
    let semAvailable = true;
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
      // Semantic search unavailable → boost is uniformly 1.0 (keyword-only ranking).
      semAvailable = false;
    }

    // Map wiki result title → similarity (by bare skill name) for the boost
    // lookup. Only the highest similarity per skill is kept (wiki may return
    // a skill under multiple titles in principle; take the max).
    const similarityByName = new Map<string, number>();
    if (semAvailable) {
      for (const r of semResults) {
        const baseName = baseSkillNameFromWikiTitle(r.document.title).toLowerCase();
        if (!baseName) continue;
        const prev = similarityByName.get(baseName);
        if (prev === undefined || r.similarity > prev) {
          similarityByName.set(baseName, r.similarity);
        }
      }
    }

    // Phase 1: positional-points scoreboard over the extracted keywords.
    const allSkills = ctx.skill.listSkills();
    const index = buildKeywordIndex(allSkills);
    const scoreboard = scoreByKeywords(keywords, index);

    // Phase 2: apply the semantic boost. points>0 is already guaranteed by
    // the scoreboard (only skills that matched ≥1 keyword appear). A skill
    // below the similarity threshold keeps boost=1.0 (never excluded).
    const ranked: { skill: Skill; points: number; boost: number; score: number }[] = [];
    for (const { skill, points } of scoreboard.values()) {
      const sim = similarityByName.get(skill.name.toLowerCase());
      let boost = 1.0;
      if (sim !== undefined && sim > threshold) {
        boost = 1 + (sim - threshold);
      }
      ranked.push({ skill, points, boost, score: points * boost });
    }

    // Phase 3: gate + order + top-N. score > floor STRICT; points > 0 is the
    // hard precondition (already enforced by the scoreboard; no pure-semantic
    // entry can appear because such a skill would have 0 points and never
    // entered the scoreboard).
    ranked.sort((a, b) => b.score - a.score);
    const kept = ranked.filter(r => r.score > SKILL_SCORE_FLOOR).slice(0, SKILL_TOP_N);

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
      const sim = similarityByName.get(r.skill.name.toLowerCase());
      const pct = sim !== undefined ? ` · ${Math.round(sim * 100)}% semantic` : '';
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