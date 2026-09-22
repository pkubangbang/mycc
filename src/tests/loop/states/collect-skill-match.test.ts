/**
 * collect-skill-match.test.ts — Unit tests for the baseline skill-match gate
 * (`SkillSuggester.matchesBaselineGate`, a private method).
 *
 *   baseline = min(Y - 1, (X / W) * Y)
 *   match    = Z >= baseline          (Z = exact-token intersection count)
 *
 *   X = per-skill keyword count
 *   W = total keyword-universe size
 *   Y = query keyword count, clamped to [2, 5]
 *
 * matchesBaselineGate is a private method on the SkillSuggester singleton.
 * These tests invoke it via a bracket-call helper on the shared singleton
 * instance (no spy needed — the tests assert return values, not call
 * counts, so the real implementation runs directly). The integration tests
 * in collect-keyword-integration.test.ts cover the real handleCollect() path.
 */
import { describe, it, expect } from 'vitest';
import { skillSuggester } from '../../../loop/states/collect-skill.js';

/**
 * Bracket-call the private matchesBaselineGate on the singleton. The method
 * is pure (no instance state), so the shared singleton's throttle fields are
 * irrelevant here; the real implementation runs and its boolean return is
 * asserted directly.
 */
function gate(skillKeywords: string[], keywords: string[], W: number): boolean {
  return (skillSuggester as unknown as {
    matchesBaselineGate(sk: string[], kw: string[], w: number): boolean;
  }).matchesBaselineGate(skillKeywords, keywords, W);
}

describe('matchesBaselineGate — exact-token intersection (no substring)', () => {
  it('matches on an exact shared token', () => {
    // X=3, W=10, Y=2 (clamped from 1). expected = 0.6, Y-1 = 1 → baseline = 0.6.
    // Z = 1 >= 0.6 → match.
    expect(gate(['go', 'rust', 'python'], ['go'], 10)).toBe(true);
  });

  it('does NOT match on a substring ("go" must not match "logging")', () => {
    // A substring `includes` filter would let "go" match "logging"; the
    // exact-token intersection kills that. Z = 0 → no match.
    expect(gate(['logging', 'debug'], ['go'], 10)).toBe(false);
  });

  it('does NOT match on a superstring ("logging" must not match "log")', () => {
    // Bidirectional substring also matched the other way; exact-token kills it.
    expect(gate(['go', 'run'], ['logging'], 10)).toBe(false);
  });

  it('matching is case-insensitive on both sides', () => {
    expect(gate(['Go', 'Rust'], ['GO', 'rust'], 10)).toBe(true);
  });
});

describe('matchesBaselineGate — the baseline bar', () => {
  it('demands more overlap as the query grows (Y - 1 scales the cap)', () => {
    // Skill owns 3 of W=12 universe tokens; query has Y tokens, all hitting.
    // expected = (3/12)*Y = 0.25*Y. baseline = min(Y-1, 0.25Y).
    //   Y=2 → baseline = min(1, 0.5) = 0.5; Z=2 hits → match.
    //   Y=4 → baseline = min(3, 1.0) = 1.0; Z=4 hits → match.
    //   Y=5 → baseline = min(4, 1.25) = 1.25; Z=5 hits → match.
    const skill = ['a', 'b', 'c'];
    expect(gate(skill, ['a', 'b'], 12)).toBe(true);
    expect(gate(skill, ['a', 'b', 'c', 'd'], 12)).toBe(true);
    expect(gate(skill, ['a', 'b', 'c', 'd', 'e'], 12)).toBe(true);
  });

  it('rejects when overlap is below the E[Z] proportionality bar', () => {
    // Fat skill: X=8 of W=10. Y=2 (clamped). expected = (8/10)*2 = 1.6.
    // baseline = min(1, 1.6) = 1. Z = 1 → 1 >= 1 → match (barely).
    // But Z = 0 → rejected by the floor anyway. Probe the boundary with Y=5:
    //   expected = (8/10)*5 = 4.0; baseline = min(4, 4.0) = 4. Z must be >= 4.
    //   Z = 3 → 3 >= 4 is false → rejected (fat skill needs real overlap).
    const skill = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(gate(skill, ['a', 'b', 'c', 'x', 'y'], 10)).toBe(false);
    expect(gate(skill, ['a', 'b', 'c', 'd', 'x'], 10)).toBe(true);
  });

  it('Y - 1 caps the demand so a fat skill cannot self-promote on tiny overlap', () => {
    // Vocabulary-bloat self-promotion: a skill owning almost all of a small
    // universe. X=9, W=10, Y=5. expected = (9/10)*5 = 4.5; baseline = min(4, 4.5) = 4.
    // The Y-1 cap forces Z >= 4 — a single token hit (Z=1) does NOT pass even
    // though E[Z] is huge. The cap blocks self-promotion without a separate rule.
    const skill = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(gate(skill, ['a', 'x', 'y', 'z', 'q'], 10)).toBe(false); // Z=1
    expect(gate(skill, ['a', 'b', 'c', 'd', 'x'], 10)).toBe(true);  // Z=4
  });

  it('is permissive for a small skill in a large universe', () => {
    // X=2, W=100, Y=2. expected = (2/100)*2 = 0.04; baseline = min(1, 0.04) = 0.04.
    // Z = 1 → 1 >= 0.04 → match. A single exact hit surfaces a niche skill.
    expect(gate(['niche', 'rare'], ['niche'], 100)).toBe(true);
  });
});

describe('matchesBaselineGate — Y clamp [2, 5]', () => {
  it('clamps a 1-keyword query up to Y=2 (so Y-1=1 keeps a meaningful bar)', () => {
    // Y observed = 1 → clamped to 2. X=2, W=10. expected = 0.4; baseline = min(1, 0.4) = 0.4.
    // Z = 1 → match.
    expect(gate(['go', 'rust'], ['go'], 10)).toBe(true);
  });

  it('clamps a huge query down to Y=5 (so Y-1=4 does not dominate small W)', () => {
    // Y observed = 8 → clamped to 5. X=2, W=10. expected = (2/10)*5 = 1.0;
    // baseline = min(4, 1.0) = 1.0. Z = 1 → match (the cap keeps it satisfiable).
    const skill = ['go', 'rust'];
    const query = ['go', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
    expect(gate(skill, query, 10)).toBe(true);
  });
});

describe('matchesBaselineGate — edge cases', () => {
  it('keywordless skill (X=0) never matches', () => {
    expect(gate([], ['go', 'rust'], 10)).toBe(false);
  });

  it('zero overlap (Z=0) never matches', () => {
    expect(gate(['a', 'b'], ['x', 'y'], 10)).toBe(false);
  });

  it('W=0 (no universe) falls back to the Z > 0 floor', () => {
    // No null model is available (E[Z] would divide by zero). A single
    // exact-token hit still surfaces the skill.
    expect(gate(['go', 'rust'], ['go'], 0)).toBe(true);
    expect(gate(['go', 'rust'], ['x'], 0)).toBe(false);
  });

  it('W=1 falls back to the Z > 0 floor (no degenerate bar)', () => {
    // W=1: expected = (X/1)*Y could be huge; the floor path avoids that.
    expect(gate(['go'], ['go'], 1)).toBe(true);
    expect(gate(['go'], ['x'], 1)).toBe(false);
  });

  it('Z >= continuous baseline works on the float threshold', () => {
    // baseline is a float (e.g. 0.6); Z is an integer. Z=1 >= 0.6 passes,
    // Z=0 is rejected by the floor. This pins that the comparison is the
    // raw `Z >= baseline` (NOT `Z >= ceil(baseline)`, which over-suppresses
    // at small W).
    expect(gate(['a', 'b', 'c'], ['a'], 10)).toBe(true); // baseline 0.6, Z=1
  });
});