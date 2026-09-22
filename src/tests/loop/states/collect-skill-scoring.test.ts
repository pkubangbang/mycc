/**
 * collect-skill-scoring.test.ts — Unit tests for the positional skill
 * scoring used by the proactive suggester (`SkillSuggester.keywordPoints`
 * and `SkillSuggester.semanticBoost`, both private methods).
 *
 * Contract (pinned; mirrored byte-for-byte in skill_search.ts):
 *   points = Σ WEIGHTS[i] for each significance-ordered query keyword kw[i]
 *            (i < 5) the skill owns as an exact, case-insensitive token.
 *            WEIGHTS = [10, 7, 5, 3, 2]
 *   boost  = 1 + (sim − threshold)   when sim > threshold   (0.5 → 1.0,
 *                                    0.7 → 1.2, 0.9 → 1.4)
 *          = 1.0                    otherwise (keyword-matched skill that
 *                                    misses the semantic window is NEVER
 *                                    excluded — soft boost, not intersection)
 *   score  = points × boost;  gate: score > 10 STRICT;  top 3.
 *
 * Both methods are pure (no instance state), so the shared singleton's
 * throttle fields are irrelevant here. They are private, so the tests
 * bracket-call them — the real implementation runs and its return value is
 * asserted directly. The integration tests in
 * collect-keyword-integration.test.ts cover the real handleCollect() path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Bracket-call the private keywordPoints on the singleton. */
function points(skillKeywords: string[], keywords: string[]): number {
  return (skillSuggester as unknown as {
    keywordPoints(sk: string[], kw: string[]): number;
  }).keywordPoints(skillKeywords, keywords);
}

/** Bracket-call the private semanticBoost on the singleton. */
function boost(similarity: number): number {
  return (skillSuggester as unknown as {
    semanticBoost(sim: number): number;
  }).semanticBoost(similarity);
}

let skillSuggester: typeof import('../../../loop/states/collect-skill.js').skillSuggester;

// getSkillMatchThreshold reads env; pin it to the documented default 0.5 so
// the boost arithmetic below is deterministic regardless of the developer's
// local SKILL_MATCH_THRESHOLD.
beforeEach(async () => {
  vi.stubEnv('SKILL_MATCH_THRESHOLD', '0.5');
  ({ skillSuggester } = await import('../../../loop/states/collect-skill.js'));
});

describe('keywordPoints — positional weights [10, 7, 5, 3, 2]', () => {
  it('awards the 1st keyword 10 points and the 2nd 7 (sum 17)', () => {
    // The user's canonical example: query [restart, mycc, instance] and a
    // skill owning the first two keywords → 10 + 7 = 17.
    expect(points(['restart', 'mycc'], ['restart', 'mycc', 'instance'])).toBe(17);
  });

  it('awards the full vector when a skill owns all five keywords', () => {
    // 10 + 7 + 5 + 3 + 2 = 27.
    expect(points(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e'])).toBe(27);
  });

  it('ignores keywords beyond the 5th position', () => {
    // Only the first five positions have weights; kw[5] and kw[6] contribute 0.
    expect(points(['f', 'g'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(0);
    // Sanity: the same skill owning kw[0] scores only the 1st-position weight.
    expect(points(['a', 'f', 'g'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(10);
  });

  it('accumulates disjoint positional hits (1st + 4th = 13)', () => {
    expect(points(['a', 'd'], ['a', 'b', 'c', 'd', 'e'])).toBe(13);
  });

  it('scores 0 when the skill owns none of the query keywords', () => {
    // points === 0 is the HARD precondition — a pure-semantic skill can never
    // surface (0 × anything = 0), no matter how high the similarity.
    expect(points(['x', 'y', 'z'], ['restart', 'mycc', 'instance'])).toBe(0);
  });
});

describe('keywordPoints — exact-token membership (no substring)', () => {
  it('matches on an exact shared token', () => {
    expect(points(['go', 'rust', 'python'], ['go'])).toBe(10);
  });

  it('folds case on the skill side (query keywords arrive lowercased)', () => {
    // extractKeywords guarantees the query keywords are already lowercased
    // (order preserved); the skill's own frontmatter keywords are the side
    // that may carry case, so THAT is what keywordPoints folds. Both
    // positions match → 10 + 7 = 17.
    expect(points(['Go', 'Rust'], ['go', 'rust'])).toBe(17);
  });

  it('does NOT match a substring ("go" must not match "logging")', () => {
    // A naive `includes` would let "go" hit "logging"; exact-token
    // membership must not.
    expect(points(['logging'], ['go'])).toBe(0);
  });
});

describe('semanticBoost — linear around the similarity threshold', () => {
  it('is neutral (1.0) at the threshold', () => {
    expect(boost(0.5)).toBeCloseTo(1.0, 10);
  });

  it('reproduces the pinned anchors 0.7 → 1.2 and 0.9 → 1.4', () => {
    expect(boost(0.7)).toBeCloseTo(1.2, 10);
    expect(boost(0.9)).toBeCloseTo(1.4, 10);
  });

  it('rises to 1.5 at perfect similarity', () => {
    expect(boost(1.0)).toBeCloseTo(1.5, 10);
  });
});

describe('score = points × boost — the strict > 10 gate', () => {
  it('points ≥ 12 passes unconditionally (12 × 1.0 > 10)', () => {
    // 1st + 4th = 10 + 3 = 13; with no semantic hit the boost is 1.0.
    const p = points(['a', 'd'], ['a', 'b', 'c', 'd', 'e']);
    expect(p * 1.0).toBeGreaterThan(10);
  });

  it('points = 10 needs a semantic hit (10 × 1.0 is NOT > 10)', () => {
    // Boundary of the STRICT gate: 10 × 1.0 = 10, which does NOT pass.
    const p = points(['a'], ['a', 'b', 'c', 'd', 'e']);
    expect(p).toBe(10);
    expect(p * 1.0).toBeLessThanOrEqual(10);
    expect(p * 1.2).toBeGreaterThan(10);
  });

  it('points ≤ 5 can never clear the floor (5 × 1.5 = 7.5)', () => {
    // 5th-position keyword only: 2 points; even at perfect similarity the
    // score is far below 10.
    const p = points(['e'], ['a', 'b', 'c', 'd', 'e']);
    expect(p).toBe(2);
    expect(p * boost(1.0)).toBeLessThanOrEqual(10);
  });

  it('a 7-point match rides a genuine semantic hit (7 × 1.4 = 9.8 → FAIL)', () => {
    // 2nd-position keyword = 7 points. Even a strong 0.9 similarity
    // (boost 1.4) gives 9.8, which does NOT clear the strict > 10 gate.
    const p = points(['b'], ['a', 'b', 'c', 'd', 'e']);
    expect(p).toBe(7);
    expect(p * boost(0.9)).toBeCloseTo(9.8, 10);
    expect(p * boost(0.9)).toBeLessThanOrEqual(10);
  });

  it('a 10-point match with a 0.7 hit passes (10 × 1.2 = 12 > 10)', () => {
    const p = points(['a'], ['a', 'b', 'c', 'd', 'e']);
    expect(p).toBe(10);
    expect(p * boost(0.7)).toBeCloseTo(12, 10);
    expect(p * boost(0.7)).toBeGreaterThan(10);
  });

  it('a keyword-matched skill absent from the semantic window keeps boost 1.0', () => {
    // Soft boost, not intersection: a missing similarity must not exclude the
    // skill. 1st + 2nd keywords = 17 → 17 × 1.0 = 17 still clears the floor.
    const p = points(['restart', 'mycc'], ['restart', 'mycc', 'instance']);
    expect(p * 1.0).toBeGreaterThan(10);
  });
});
