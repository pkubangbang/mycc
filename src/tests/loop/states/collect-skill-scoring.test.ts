/**
 * collect-skill-scoring.test.ts — Unit tests for the SHARED skill scorer
 * (`scoreSkills` from src/loop/skill-matcher.ts) as consumed by the proactive
 * suggester. `collect-skill.ts` no longer owns a scorer — it delegates to the
 * same function the `skill_search` tool calls, so these tests pin the scoring
 * contract at its single source of truth.
 *
 * Contract:
 *   points = Σ WEIGHTS[i] for each significance-ordered query keyword kw[i]
 *            (i < 5) the skill owns as an exact, case-insensitive token.
 *            WEIGHTS = [10, 7, 5, 3, 2]   (query keywords arrive already
 *            lowercased from extractKeywords — the scorer does not
 *            re-lowercase the query side)
 *   boost  = 1 + (sim − threshold)   when sim > threshold   (0.5 → 1.0,
 *                                    0.7 → 1.2, 0.9 → 1.4)
 *          = 1.0                    otherwise (keyword-matched skill that
 *                                    misses the semantic window is NEVER
 *                                    excluded — soft boost, not intersection)
 *   score  = points × boost;  gate: score > 10 STRICT;  top 3.
 *   similarity is matched by the FULL `${scope}:${name}` qualified wiki title
 *   (the P1 scope-collision fix), so a same-named skill from ANOTHER scope
 *   contributes no boost.
 *
 * The integration tests in collect-keyword-integration.test.ts cover the real
 * handleCollect() path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Skill, SearchResult } from '../../../types.js';
import { scoreSkills } from '../../../loop/skill-matcher.js';
import { loader } from '../../../context/shared/loader.js';

/**
 * Build a bare Skill (content unused by the scorer).
 */
function mkSkill(name: string, keywords: string[]): Skill {
  return { name, description: '', keywords, content: '' };
}

/**
 * Build a fake wiki SearchResult. `title` is the FULL qualified title
 * ("${scope}:${name}") — the scorer keys similarities by it.
 */
function wikiRow(title: string, similarity: number): SearchResult {
  return {
    document: { domain: 'skills', title, content: '', references: [] },
    similarity,
    hash: 'h',
  };
}

/**
 * Stub loader.buildAllSkillEntries() so the local skill set maps to its own
 * qualified titles. `scopeByName` gives each local skill its scope; a skill
 * not present defaults to scope 'proj'.
 */
function setLocalScopes(scopeByName: Record<string, string>): void {
  vi.spyOn(loader, 'buildAllSkillEntries').mockReturnValue(
    Object.entries(scopeByName).map(([name, scope]) => ({
      document: {
        domain: 'skills',
        title: `${scope}:${name}`,
        content: '',
        references: [],
      },
      contentHash: 'h',
    })),
  );
}

// Pin the threshold to the documented default 0.5 so the boost arithmetic is
// deterministic regardless of the developer's local SKILL_MATCH_THRESHOLD.
beforeEach(() => {
  vi.restoreAllMocks();
});

const THRESHOLD = 0.5;

/** Score a single skill and return [points, boost, score] (or null if dropped). */
function one(
  skill: Skill,
  keywords: string[],
  semanticResults: SearchResult[] = [],
  scope = 'proj',
): { points: number; boost: number; score: number } | null {
  setLocalScopes({ [skill.name]: scope });
  const ranked = scoreSkills({ skills: [skill], keywords, semanticResults, threshold: THRESHOLD });
  if (ranked.length === 0) return null;
  const r = ranked[0];
  return { points: r.points, boost: r.boost, score: r.score };
}

/**
 * Points helper. scoreSkills applies the strict `> 10` gate, so a sub-floor
 * skill is dropped and its `points` cannot be read back. To expose the RAW
 * positional points regardless of the gate, this helper attaches a
 * high-similarity semantic row for the SAME scope (sim 1.0 → boost 1.5):
 * `score = points × 1.5 > 10` holds for any points ≥ 7, and `points` itself
 * is gate-independent, so we read it directly. For points below that (which
 * can never clear the floor anyway) the caller asserts the drop via `one()`.
 *
 * IMPORTANT — the OOV fix (positional weights apply to MATCHING evidence,
 * not the raw keyword list): to pin a keyword at a SPECIFIC evidence position
 * `p`, every keyword BEFORE it in the query must also be matchable, otherwise
 * the target collapses to an earlier position. The helper therefore accepts
 * an optional `padSkillKeywords` list — when given, a padding skill owning
 * those keywords is added so the query's full ordering is preserved as real
 * evidence positions. Omit it only when the target is the sole/first match.
 */
function points(
  skillKeywords: string[],
  keywords: string[],
  name = 's',
  padSkillKeywords: string[] = [],
): number {
  const target = mkSkill(name, skillKeywords);
  const skills = padSkillKeywords.length ? [target, mkSkill(`${name}-pad`, padSkillKeywords)] : [target];
  const scopes: Record<string, string> = { [name]: 'proj' };
  if (padSkillKeywords.length) scopes[`${name}-pad`] = 'proj';
  setLocalScopes(scopes);
  const ranked = scoreSkills({ skills, keywords, semanticResults: [wikiRow(`proj:${name}`, 1.0)], threshold: THRESHOLD });
  const r = ranked.find(x => x.skill.name === name);
  return r ? r.points : 0;
}

/**
 * Boost helper: force a matching-scope similarity on a 2-keyword (17-pt)
 * skill so it clears the gate, then read the resulting boost factor.
 */
function boostOf(similarity: number): number {
  const res = one(mkSkill('s', ['a', 'b']), ['a', 'b'], [wikiRow('proj:s', similarity)]);
  return res ? res.boost : NaN;
}

describe('scoreSkills — positional weights [10, 7, 5, 3, 2]', () => {
  it('awards the 1st keyword 10 points and the 2nd 7 (sum 17)', () => {
    // The user's canonical example: query [restart, mycc, instance] and a
    // skill owning the first two keywords → 10 + 7 = 17.
    expect(points(['restart', 'mycc'], ['restart', 'mycc', 'instance'], 'mycc-online-hotfix')).toBe(17);
  });

  it('awards the full vector when a skill owns all five keywords', () => {
    // 10 + 7 + 5 + 3 + 2 = 27.
    expect(points(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e'])).toBe(27);
  });

  it('ignores keywords beyond the 5th position', () => {
    // To land a keyword at evidence position ≥5 (so it scores 0), the five
    // keywords before it must be MATCHABLE — otherwise the OOV fix collapses
    // it to an earlier position. A padding skill owns the first five so the
    // target `f`/`g` genuinely sit at evidence positions 5/6 → 0 points.
    expect(points(['f', 'g'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'tgt', ['a', 'b', 'c', 'd', 'e'])).toBe(0);
    // Sanity: the same skill owning kw[0] scores only the 1st-position weight.
    expect(points(['a', 'f', 'g'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'tgt2', ['b', 'c', 'd', 'e'])).toBe(10);
  });

  it('accumulates disjoint positional hits (1st + 4th = 13)', () => {
    // Query [a,b,c,d,e]; the target owns a (pos 0 → 10) and d (pos 3 → 3).
    // b/c/e must be matchable (via a padding skill) so d stays at position 3
    // rather than collapsing to position 1. 10 + 3 = 13.
    expect(points(['a', 'd'], ['a', 'b', 'c', 'd', 'e'], 'tgt', ['b', 'c', 'e'])).toBe(13);
  });

  it('scores 0 when the skill owns none of the query keywords (dropped)', () => {
    // points === 0 is the HARD precondition — a pure-semantic skill can never
    // surface (0 × anything = 0), so it is filtered out entirely.
    const ranked = scoreSkills({
      skills: [mkSkill('s', ['x', 'y', 'z'])],
      keywords: ['restart', 'mycc', 'instance'],
      semanticResults: [wikiRow('proj:s', 1.0)],
      threshold: THRESHOLD,
    });
    expect(ranked).toHaveLength(0);
  });
});

describe('scoreSkills — exact-token membership (no substring)', () => {
  it('matches on an exact shared token (1st-position = 10 pts)', () => {
    // A single-keyword query gives the matched skill exactly 10 pts, which is
    // AT the floor — so it is dropped. Assert the raw points via a 2-keyword
    // query where the position-1 hit contributes 10 (17 total with a 2nd hit).
    expect(points(['a', 'b'], ['a', 'b'])).toBe(17);
  });

  it('folds case on the skill side (query keywords arrive lowercased)', () => {
    // extractKeywords guarantees the query keywords are already lowercased
    // (order preserved); the skill's own frontmatter keywords are the side
    // that may carry case, so THAT is what the scorer folds. Both
    // positions match → 10 + 7 = 17.
    expect(points(['Go', 'Rust'], ['go', 'rust'])).toBe(17);
  });

  it('does NOT match a substring ("go" must not match "logging")', () => {
    // A naive `includes` would let "go" hit "logging"; exact-token
    // membership must not.
    expect(points(['logging'], ['go'])).toBe(0);
  });
});

describe('scoreSkills — semantic boost is linear around the threshold', () => {
  it('is neutral (1.0) at the threshold', () => {
    expect(boostOf(0.5)).toBeCloseTo(1.0, 10);
  });

  it('reproduces the pinned anchors 0.7 → 1.2 and 0.9 → 1.4', () => {
    expect(boostOf(0.7)).toBeCloseTo(1.2, 10);
    expect(boostOf(0.9)).toBeCloseTo(1.4, 10);
  });

  it('rises to 1.5 at perfect similarity', () => {
    expect(boostOf(1.0)).toBeCloseTo(1.5, 10);
  });
});

describe('scoreSkills — score = points × boost, strict > 10 gate', () => {
  it('points ≥ 12 passes unconditionally (12 × 1.0 > 10)', () => {
    // 1st + 4th = 10 + 3 = 13; with no semantic hit the boost is 1.0. b/c/e
    // are matchable via a padding skill so d stays at evidence position 3.
    setLocalScopes({ tgt: 'proj', pad: 'proj' });
    const ranked = scoreSkills({
      skills: [mkSkill('tgt', ['a', 'd']), mkSkill('pad', ['b', 'c', 'e'])],
      keywords: ['a', 'b', 'c', 'd', 'e'],
      semanticResults: [],
      threshold: THRESHOLD,
    });
    const r = ranked.find(x => x.skill.name === 'tgt')!;
    expect(r.points).toBe(13);
    expect(r.score).toBeGreaterThan(10);
  });

  it('points = 10 needs a semantic hit (10 × 1.0 is NOT > 10)', () => {
    // Boundary of the STRICT gate: 10 × 1.0 = 10 → DROPPED.
    expect(one(mkSkill('s', ['a']), ['a', 'b', 'c', 'd', 'e'])).toBeNull();
    // With a 0.7 hit (boost 1.2): 10 × 1.2 = 12 > 10 → PASSES.
    const hit = one(mkSkill('s', ['a']), ['a', 'b', 'c', 'd', 'e'], [wikiRow('proj:s', 0.7)]);
    expect(hit!.score).toBeCloseTo(12, 10);
  });

  it('points ≤ 5 can never clear the floor (5 × 1.5 = 7.5)', () => {
    // 5th-position keyword = 2 points. To land `e` at evidence position 4,
    // a/b/c/d must be matchable (padding skill) so `e` doesn't collapse to
    // position 0 (weight 10). Even at perfect similarity the score is
    // 2 × 1.5 = 3.0, far below 10 → dropped.
    setLocalScopes({ tgt: 'proj', pad: 'proj' });
    expect(
      scoreSkills({
        skills: [mkSkill('tgt', ['e']), mkSkill('pad', ['a', 'b', 'c', 'd'])],
        keywords: ['a', 'b', 'c', 'd', 'e'],
        semanticResults: [wikiRow('proj:tgt', 1.0)],
        threshold: THRESHOLD,
      }).find(x => x.skill.name === 'tgt'),
    ).toBeUndefined();
  });

  it('a 7-point match rides a genuine semantic hit but still fails (7 × 1.4 = 9.8)', () => {
    // 2nd-position keyword = 7 points. `a` must be matchable (padding skill)
    // so `b` stays at evidence position 1 (weight 7), not position 0 (10).
    // Even a strong 0.9 similarity (boost 1.4) gives 9.8, NOT > 10 → dropped.
    setLocalScopes({ tgt: 'proj', pad: 'proj' });
    expect(
      scoreSkills({
        skills: [mkSkill('tgt', ['b']), mkSkill('pad', ['a', 'c', 'd', 'e'])],
        keywords: ['a', 'b', 'c', 'd', 'e'],
        semanticResults: [wikiRow('proj:tgt', 0.9)],
        threshold: THRESHOLD,
      }).find(x => x.skill.name === 'tgt'),
    ).toBeUndefined();
  });

  it('a 10-point match with a 0.7 hit passes (10 × 1.2 = 12 > 10)', () => {
    const r = one(mkSkill('s', ['a']), ['a', 'b', 'c', 'd', 'e'], [wikiRow('proj:s', 0.7)]);
    expect(r!.points).toBe(10);
    expect(r!.boost).toBeCloseTo(1.2, 10);
    expect(r!.score).toBeGreaterThan(10);
  });

  it('a keyword-matched skill absent from the semantic window keeps boost 1.0', () => {
    // Soft boost, not intersection: a missing similarity must not exclude the
    // skill. 1st + 2nd keywords = 17 → 17 × 1.0 = 17 still clears the floor.
    const r = one(mkSkill('mycc-online-hotfix', ['restart', 'mycc']), ['restart', 'mycc', 'instance']);
    expect(r!.boost).toBe(1);
    expect(r!.score).toBe(17);
  });
});

describe('scoreSkills — P1 scope collision (similarity matched by qualified title)', () => {
  it('another PROJECT scope\'s row does NOT boost the local same-named skill', () => {
    // Local skill is project 'projA'; the wiki returns a row for project
    // 'projB' with the SAME bare name and a high similarity. The old
    // bare-name keying would have applied projB's 0.9; the scope-aware keying
    // must NOT → boost stays 1.0 → 17 × 1.0 = 17.
    setLocalScopes({ 'code-review': 'projA' });
    const ranked = scoreSkills({
      skills: [mkSkill('code-review', ['restart', 'mycc'])],
      keywords: ['restart', 'mycc'],
      semanticResults: [wikiRow('projB:code-review', 0.9)],
      threshold: THRESHOLD,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].boost).toBe(1);
    expect(ranked[0].score).toBe(17);
    expect(ranked[0].similarity).toBeUndefined();
  });

  it('a [user] scope\'s row does NOT boost a local project\'s same-named skill', () => {
    // [user] and [built-in] are CONSTANT scope strings on every machine, so
    // this collision hits EVERY project — the widest form of the bug.
    setLocalScopes({ 'code-review': 'mycc' });
    const ranked = scoreSkills({
      skills: [mkSkill('code-review', ['restart', 'mycc'])],
      keywords: ['restart', 'mycc'],
      semanticResults: [wikiRow('[user]:code-review', 0.92)],
      threshold: THRESHOLD,
    });
    expect(ranked[0].boost).toBe(1);
    expect(ranked[0].score).toBe(17);
  });

  it('positive control: the MATCHING scope\'s row DOES boost', () => {
    // Same setup, but the wiki row\'s scope matches the local skill\'s. This
    // confirms the fix does not over-restrict: 17 × ... with sim 0.9
    // (boost 1.4) = 23.8.
    setLocalScopes({ 'code-review': 'mycc' });
    const ranked = scoreSkills({
      skills: [mkSkill('code-review', ['restart', 'mycc'])],
      keywords: ['restart', 'mycc'],
      semanticResults: [wikiRow('mycc:code-review', 0.9)],
      threshold: THRESHOLD,
    });
    expect(ranked[0].boost).toBeCloseTo(1.4, 10);
    expect(ranked[0].score).toBeCloseTo(23.8, 10);
    expect(ranked[0].similarity).toBeCloseTo(0.9, 10);
  });
});

describe('scoreSkills — P1 OOV: unmatchable concepts do not distort positions', () => {
  // The extractor may emit arbitrary concepts not in any skill's keyword set
  // (e.g. "pg_dump"). Under the OLD scorer, such a concept at position 1
  // would demote a real keyword from weight 10 to weight 7 — and with a
  // 0.9/0.5 boost that flips a match past the strict >10 gate (10×1.4=14
  // passes vs 7×1.4=9.8 fails). The fix: the scorer drops unmatchable
  // concepts BEFORE assigning positions, so positional weights apply to
  // ranked MATCHING evidence, not the raw LLM list. The extractor stays free
  // to emit arbitrary concepts (useful for the freeform/semantic path).

  it('property: inserting an OOV concept ahead of real keywords changes nothing', () => {
    // Query A = [backup, postgres]; Query B = [pg_dump, backup, postgres]
    // where pg_dump is NOT owned by any skill. The relative points of the
    // backup/postgres skills must be identical between A and B — the OOV
    // concept is dropped before positions are assigned.
    //
    // Both skills own only one query keyword (10 / 7 pts), which sits AT or
    // BELOW the strict >10 floor, so a matching-scope semantic hit (sim 1.0
    // → boost 1.5) is attached to make them readable through the gate. The
    // boost is identical for A and B, so it cannot mask a positional change.
    const backup = mkSkill('backup', ['backup']);
    const postgres = mkSkill('postgres', ['postgres']);
    setLocalScopes({ backup: 'proj', postgres: 'proj' });
    const sem = [wikiRow('proj:backup', 1.0), wikiRow('proj:postgres', 1.0)];
    const scoreBoth = (kws: string[]) =>
      scoreSkills({ skills: [backup, postgres], keywords: kws, semanticResults: sem, threshold: THRESHOLD });

    const a = scoreBoth(['backup', 'postgres']);
    const b = scoreBoth(['pg_dump', 'backup', 'postgres']);

    // backup = evidence[0] → 10 in both; postgres = evidence[1] → 7 in both.
    const aBackup = a.find(x => x.skill.name === 'backup')!;
    const aPg = a.find(x => x.skill.name === 'postgres')!;
    const bBackup = b.find(x => x.skill.name === 'backup')!;
    const bPg = b.find(x => x.skill.name === 'postgres')!;
    expect(aBackup.points).toBe(bBackup.points); // 10 === 10
    expect(aPg.points).toBe(bPg.points); // 7 === 7
    expect(aBackup.points).toBe(10);
    expect(aPg.points).toBe(7);
    // pg_dump contributed zero entries (no skill owns it) — same count.
    expect(a).toHaveLength(b.length);
  });

  it('an OOV concept at position 1 does NOT demote a 10-pt match to 7', () => {
    // The exact gate-flip scenario from the review: a skill owning `backup`
    // with a 0.9 similarity (boost 1.4). With the OOV concept dropped,
    // backup stays at evidence position 0 → 10 × 1.4 = 14 > 10 (PASSES).
    // Under the old scorer it would have been 7 × 1.4 = 9.8 (DROPPED).
    setLocalScopes({ backup: 'proj' });
    const ranked = scoreSkills({
      skills: [mkSkill('backup', ['backup'])],
      keywords: ['pg_dump', 'backup', 'postgres'],
      semanticResults: [wikiRow('proj:backup', 0.9)],
      threshold: THRESHOLD,
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].points).toBe(10);
    expect(ranked[0].boost).toBeCloseTo(1.4, 10);
    expect(ranked[0].score).toBeCloseTo(14, 10);
  });

  it('an OOV-only query scores 0 (no matchable evidence)', () => {
    // If every extracted keyword is unmatchable, there is no evidence → no
    // candidates (pure-semantic entry remains impossible by construction).
    setLocalScopes({ s: 'proj' });
    const ranked = scoreSkills({
      skills: [mkSkill('s', ['backup'])],
      keywords: ['pg_dump', 'wal_archive'],
      semanticResults: [wikiRow('proj:s', 1.0)],
      threshold: THRESHOLD,
    });
    expect(ranked).toHaveLength(0);
  });
});

describe('scoreSkills — P2 duplicates: a skill owns a keyword ONCE', () => {
  it('duplicate skill-keyword entries do not manufacture points', () => {
    // skill keywords ["code","code"] + query ["code"] must be 10, not 10+10=20.
    // The scorer dedups a skill's own keyword set when building the index.
    expect(points(['code', 'code'], ['code'], 'dup-skill')).toBe(10);
  });

  it('duplicate query keywords do not manufacture points', () => {
    // query ["code","code"] against skill ["code"] must be 10, not 10+7=17.
    // extractKeywords dedups the query preserving first occurrence; the
    // scorer also dedups defensively so the positional weight applies once.
    expect(points(['code'], ['code', 'code'], 'dup-query')).toBe(10);
  });

  it('dedup keeps first occurrence (significance order preserved)', () => {
    // query [a, a, b]: a is deduped to evidence[0] (weight 10), b is
    // evidence[1] (weight 7) → 17, NOT a=10+a=7+b=5=22.
    expect(points(['a', 'b'], ['a', 'a', 'b'], 'dedup-order')).toBe(17);
  });
});

describe('scoreSkills — ordering + top-3 truncation', () => {
  it('sorts by score desc and returns at most 3', () => {
    // Four skills all owning the 1st keyword (10 pts); give three of them
    // matching-scope similarities so they clear the floor, and rely on the
    // slice to cap at 3.
    const skills = [
      mkSkill('s0', ['a']),
      mkSkill('s1', ['a']),
      mkSkill('s2', ['a']),
      mkSkill('s3', ['a']),
    ];
    setLocalScopes({ s0: 'p', s1: 'p', s2: 'p', s3: 'p' });
    const ranked = scoreSkills({
      skills,
      keywords: ['a'],
      semanticResults: [
        wikiRow('p:s0', 0.9), // 1.4 → 14.0
        wikiRow('p:s1', 0.7), // 1.2 → 12.0
        wikiRow('p:s2', 0.6), // 1.1 → 11.0
        wikiRow('p:s3', 0.55), // 1.05 → 10.5
      ],
      threshold: THRESHOLD,
    });
    expect(ranked).toHaveLength(3);
    expect(ranked.map(r => r.skill.name)).toEqual(['s0', 's1', 's2']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });
});
