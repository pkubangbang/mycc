/**
 * skill-matcher.ts - Shared skill scorer: positional keyword points ×
 *                    scope-aware semantic boost.
 *
 * This is the SINGLE shared scoring implementation consumed by BOTH
 * skill-matching consumers:
 *   - `src/tools/skill_search.ts`         (the skill_search tool)
 *   - `src/loop/states/collect-skill.ts`  (the proactive SkillSuggester)
 *
 * It is the structural realization of the "one scoring contract" invariant
 * that the consolidation PR originally stated but only enforced socially
 * (the two consumers had duplicated scorer copies — buildKeywordIndex/
 * scoreByKeywords in skill_search.ts vs keywordPoints/semanticBoost in
 * collect-skill.ts — whose arithmetic agreed today but would drift). With
 * this module, both consumers literally cannot drift: they call the same
 * `scoreSkills` function.
 *
 * It also fixes the P1 cross-project scope-collision bug that both duplicated
 * copies shared. See {@link buildQualifiedTitleIndex} and the boost step in
 * {@link scoreSkills} for the scope-aware identity mapping.
 *
 * Import direction is safe: `src/loop/*` never imports `src/tools/*` (no
 * loop→tools edge), and `src/tools/*` already imports from `../loop/` — so
 * both consumers reach this module via a proven direction with zero
 * import-cycle risk. Same precedent as `keyword-extractor.ts`.
 */

import type { Skill, SearchResult } from '../types.js';
import { loader } from '../context/shared/loader.js';
import { getSkillMatchThreshold } from '../config.js';

/**
 * Positional weights for the 1st..5th significance-ordered query keyword.
 * The 1st (most discriminative) keyword is worth 10; the 5th is worth 2.
 * Keywords beyond the 5th are ignored by the scorer. The extractor's prompt
 * enforces significance ordering (most important keyword first) so that the
 * 1st position carries the highest weight.
 */
export const KEYWORD_WEIGHTS = [10, 7, 5, 3, 2] as const;

/** Minimum total score to surface a skill (STRICT greater-than). */
export const SKILL_SCORE_FLOOR = 10;

/** Number of skills to return (top-N after scoring + sorting). */
export const SKILL_TOP_N = 3;

/**
 * A scored skill candidate. `similarity` is the wiki embedding similarity
 * used for the boost (undefined when the skill was absent from the semantic
 * window or semantic search was unavailable → boost 1.0). Exposed so the
 * skill_search tool can render the percentage; the SkillSuggester maps this
 * to a bare `Skill[]` for its HINT injection.
 */
export interface RankedSkill {
  skill: Skill;
  /** Positional keyword points (sum of KEYWORD_WEIGHTS[i] for each owned query kw[i]). */
  points: number;
  /** Semantic boost factor applied (≥ 1.0; 1.0 when no qualifying similarity). */
  boost: number;
  /** Final score: points × boost. */
  score: number;
  /** Wiki similarity that produced the boost, or undefined (→ boost 1.0). */
  similarity?: number;
}

/**
 * Build the local process's `bare skill name → qualified wiki title` map.
 *
 * Wiki skill documents are indexed under the qualified title `${scope}:${name}`
 * (loader.buildSkillDocument), where `scope` is `[user]` / `[built-in]` /
 * `path.basename(process.cwd())` (loader.getSkillScope). The `skills` wiki
 * domain is SHARED ACROSS PROJECTS, so it holds rows from every project on
 * the machine under their own scopes.
 *
 * The P1 bug: the old scorers stripped the scope via `baseSkillNameFromWikiTitle`
 * and keyed the similarity map by BARE name, so `[projectB]:code-review`
 * (similarity 0.92) could boost a locally-loaded `[projectA]:code-review` —
 * the scope that PRODUCED the similarity was discarded before it was applied.
 * Worse, `[user]` and `[built-in]` are CONSTANT scope strings on every
 * machine, so a user/built-in `code-review` collides with EVERY project's
 * `code-review` on the box, not just sibling projects.
 *
 * The fix: map the LOCAL skill set to its OWN qualified titles (via
 * loader.buildAllSkillEntries(), whose `document.title` is the byte-identical
 * `${scope}:${name}` the wiki stored), then match wiki results by FULL
 * qualified title. A cross-project same-named skill is keyed under a
 * different qualified title and simply contributes no boost (boost 1.0) —
 * correct, instead of wrongly inheriting another scope's similarity.
 *
 * `Skill` carries no layer/scope field (types.ts), so the loader is the only
 * clean source of the local scope mapping. `buildAllSkillEntries()` already
 * produces the qualified-title documents, so no `types.ts` / `SkillModule` /
 * IPC change is needed.
 *
 * NOTE on child processes: `getSkillScope` derives the project scope from
 * `path.basename(process.cwd())`. A child spawned into a worktree computes a
 * DIFFERENT scope than the lead indexed under, so its qualified-title lookup
 * key will MISS the wiki rows the lead indexed. That miss degrades to boost
 * 1.0 (fails CLOSED) — strictly better than the old bare-name keying, which
 * would wrongly apply the OTHER scope's similarity. A miss is intentional.
 */
function buildQualifiedTitleIndex(skills: Skill[]): Map<string, string> {
  // name(lowercased) → qualified title (as the wiki stored it)
  const byName = new Map<string, string>();
  try {
    const entries = loader.buildAllSkillEntries();
    for (const e of entries) {
      const title = e.document.title; // `${scope}:${name}`
      const name = title.includes(':') ? title.split(':').slice(1).join(':') : title;
      if (name) byName.set(name.toLowerCase(), title);
    }
  } catch {
    // If the loader cannot enumerate entries (unexpected), fall back to bare
    // names — the caller still gets keyword-only ranking (boost 1.0 everywhere
    // because the qualified-title lookup will miss). Degrades safely.
  }
  // Guard: ensure every passed-in skill has a qualified title even if the
  // loader enumeration missed it (defensive — shouldn't happen, but a miss
  // must never throw). Use the bare name as its own "title" so the lookup
  // simply finds nothing in the semantic map (boost 1.0).
  for (const s of skills) {
    if (!byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s.name);
  }
  return byName;
}

/**
 * Build `qualified title(lowercased) → best similarity` from the raw wiki
 * search results. Keyed by the FULL title (NOT the stripped bare name), so
 * scope identity is preserved end-to-end and cross-project same-named skills
 * do not collide.
 */
function buildSimilarityByTitle(
  semanticResults: SearchResult[],
): Map<string, number> {
  const byTitle = new Map<string, number>();
  for (const r of semanticResults) {
    const title = r.document.title.toLowerCase();
    if (!title) continue;
    const prev = byTitle.get(title);
    if (prev === undefined || r.similarity > prev) {
      byTitle.set(title, r.similarity);
    }
  }
  return byTitle;
}

/**
 * Score every loaded skill and return the top matches, highest score first.
 *
 * PRECONDITION — the caller MUST pass `keywords` already lowercased and
 * significance-ordered. `extractKeywords` (src/loop/keyword-extractor.ts)
 * guarantees both: it lowercases each keyword, deduplicates preserving
 * first-occurrence order, and the LLM prompt enforces descending importance
 * (1st keyword = most discriminative). Neither consumer re-lowercases the
 * query side; this function relies on that invariant.
 *
 * Scoring (the single shared contract):
 *   1. Positional points: FIRST the query keywords are reduced to MATCHING
 *      EVIDENCE — those present in the skill keyword index — preserving the
 *      LLM's significance order. Unmatchable concepts the extractor emitted
 *      (e.g. "pg_dump" when no skill owns it) are dropped BEFORE positions
 *      are assigned, so a vocabulary mismatch can never demote a real
 *      keyword from position 1 (weight 10) to position 2 (weight 7). The
 *      positional weights [10,7,5,3,2] then apply to the FIRST 5 matching
 *      evidence items: each skill owning `evidence[i]` as an exact
 *      case-insensitive token earns `KEYWORD_WEIGHTS[i]` points. Evidence
 *      beyond the 5th is ignored. Only skills with points > 0 can appear
 *      (pure-semantic entry is impossible by construction).
 *      Duplicate handling: a skill's keywords are deduplicated (a skill
 *      owns a keyword ONCE, not N times), and duplicate query keywords are
 *      deduplicated preserving first occurrence — so `["code","code"]` never
 *      earns `10+7`, only `10`.
 *   2. Semantic boost: for each scored skill, look up its wiki similarity by
 *      FULL qualified title (scope-aware — see {@link buildQualifiedTitleIndex}).
 *      When `sim > threshold`, `boost = 1 + (sim - threshold)`; otherwise
 *      `boost = 1.0` (a keyword-matched skill missing the semantic window is
 *      NEVER excluded — e.g. 12 × 1.0 = 12, still suggested).
 *   3. `score = points × boost`.
 *   4. Gate `score > SKILL_SCORE_FLOOR` STRICT, sort desc, take `SKILL_TOP_N`.
 *
 * @param args.skills          - the loaded skills (ctx.skill.listSkills()).
 * @param args.keywords        - significance-ordered, LOWERCASED query keywords
 *                               (from extractKeywords). Not re-lowercased here.
 * @param args.semanticResults - the raw ctx.wiki.get(...) results; titles are
 *                               `${scope}:${name}`. Empty array when semantic
 *                               search was unavailable (→ boost 1.0 everywhere).
 * @param args.threshold       - getSkillMatchThreshold(); the boost neutral point.
 * @returns ranked candidates, top `SKILL_TOP_N`, highest score first.
 */
export function scoreSkills(args: {
  skills: Skill[];
  keywords: string[];
  semanticResults: SearchResult[];
  threshold: number;
}): RankedSkill[] {
  const { skills, keywords, semanticResults, threshold } = args;

  // Scope-aware identity maps (fix the P1 cross-project collision).
  const qualifiedTitleByName = buildQualifiedTitleIndex(skills);
  const similarityByTitle = buildSimilarityByTitle(semanticResults);

  // Phase 1: positional-points scoreboard. Build a keyword→skills index once.
  // A skill's keywords are DEDUPLICATED (a skill owns a keyword once, not N
  // times), so duplicate frontmatter entries can never manufacture extra
  // points (e.g. skill ["code","code"] + query ["code"] = 10, not 20).
  const index = new Map<string, Skill[]>();
  for (const skill of skills) {
    const seen = new Set<string>();
    for (const kw of skill.keywords) {
      const key = kw.toLowerCase();
      if (seen.has(key)) continue; // dedup within this skill's keyword set
      seen.add(key);
      const bucket = index.get(key);
      if (bucket) bucket.push(skill);
      else index.set(key, [skill]);
    }
  }

  // Reduce the LLM's keyword list to MATCHING EVIDENCE: keep only keywords
  // that at least one skill owns, PRESERVING the LLM's significance order.
  // This is the P1 OOV fix — an unmatchable concept (e.g. "pg_dump" when no
  // skill owns it) is dropped BEFORE positional weights are assigned, so it
  // cannot demote a real keyword from position 1 (weight 10) to position 2
  // (weight 7). Positional weights apply to ranked MATCHING evidence, not to
  // the raw LLM keyword list. Duplicate query keywords are also dropped here
  // (defensive — extractKeywords already dedups preserving first occurrence).
  const seenQuery = new Set<string>();
  const evidence: string[] = [];
  for (const kw of keywords) {
    if (seenQuery.has(kw)) continue; // dedup, keep first occurrence
    seenQuery.add(kw);
    if (index.has(kw)) evidence.push(kw);
  }

  // Assign positional weights to the (first 5) matching evidence items.
  const scoreboard = new Map<string, { skill: Skill; points: number }>();
  for (let i = 0; i < evidence.length; i++) {
    if (i >= KEYWORD_WEIGHTS.length) break; // only first 5 score
    const found = index.get(evidence[i]);
    if (!found) continue;
    const weight = KEYWORD_WEIGHTS[i];
    for (const skill of found) {
      const entry = scoreboard.get(skill.name);
      if (entry) entry.points += weight;
      else scoreboard.set(skill.name, { skill, points: weight });
    }
  }

  // Phase 2: scope-aware semantic boost + score. A skill absent from the
  // semantic window (or whose local qualified title doesn't match a wiki row)
  // gets boost 1.0 — never excluded.
  const ranked: RankedSkill[] = [];
  for (const { skill, points } of scoreboard.values()) {
    const qualifiedTitle = qualifiedTitleByName.get(skill.name.toLowerCase());
    const sim =
      qualifiedTitle !== undefined
        ? similarityByTitle.get(qualifiedTitle.toLowerCase())
        : undefined;
    let boost = 1.0;
    if (sim !== undefined && sim > threshold) {
      boost = 1 + (sim - threshold);
    }
    ranked.push({
      skill,
      points,
      boost,
      score: points * boost,
      similarity: sim,
    });
  }

  // Phase 3: gate (strict > floor) + order (desc) + top-N.
  ranked.sort((a, b) => b.score - a.score);
  return ranked.filter(r => r.score > SKILL_SCORE_FLOOR).slice(0, SKILL_TOP_N);
}

/**
 * Convenience: the semantic topK used by both consumers. FLAT (not derived
 * from listSkills().length) because the `skills` wiki domain is
 * cross-project and unbounded (the loader's orphan sweep is own-scope only,
 * so other projects' rows survive). Measured on a 66-row domain, topK=50
 * yields 0 hidden. A saturated window (results.length === topK) is the signal
 * to raise the cap or revive the (held) getExact design.
 */
export const SKILL_SEMANTIC_TOPK = 50;

/**
 * Re-export the threshold getter so consumers can import everything they need
 * for the ranking pipeline from one place. (Both already import config.js
 * directly today; this avoids a forced migration and keeps the call site
 * readable.)
 */
export { getSkillMatchThreshold };