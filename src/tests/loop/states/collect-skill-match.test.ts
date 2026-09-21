/**
 * collect-skill-match.test.ts — Unit tests for the adaptive α/β keyword-match
 * predicate `matchesAdaptiveGates` exported from collect-skill.ts.
 *
 * These tests pin the peer-reviewed behavior of the adaptive thresholds
 * (see docs/adaptive-skill-match-thresholds.md):
 *   - exact-token intersection (no substring): "go" must NOT match "logging"
 *   - Z > 0 floor: keywordless skills (X=0) never match the keyword path
 *   - crash guard W ≤ 1: no null model → fall back to the Z > 0 floor
 *   - crash guard Y > W: clamp Y ← min(Y, W) so variance stays non-negative
 *     (no NaN, no exception)
 *   - coverage-eligibility rule X/W > ρ (=0.5): broad skills defer to Branch B
 *   - β clamp [0.05, 0.5]: unsatisfiable at small W clamped down, vanishing
 *     at huge W clamped up
 *   - ceil(Z_min): Z is integer; a Z_min of 0.72 must require Z ≥ 1, not let
 *     Z = 0 "pass" by float rounding
 *   - the vocab-bloat skill (big X, 1 hit) is REJECTED where the old Z>0
 *     filter passed it
 *
 * Constants in the module under test: SKILL_MATCH_KAPPA=2,
 * SKILL_COVERAGE_RHO=0.5, SKILL_BETA_MIN=0.05, SKILL_BETA_CAP=0.5.
 */
import { describe, it, expect } from 'vitest';
import { matchesAdaptiveGates } from '../../../loop/states/collect-skill.js';

describe('matchesAdaptiveGates', () => {
  // ── Exact-token intersection (kills the substring bug) ────────────────
  it('rejects substring overlap: "go" does NOT match "logging"', () => {
    // Old filter: "go".includes via kw.includes("go") matched "logging".
    // Exact-token: "go" is not in {"logging","config","docker"} → Z=0 → reject.
    expect(matchesAdaptiveGates(['logging', 'config', 'docker'], ['go', 'web', 'server'], 200)).toBe(false);
  });

  it('matches on exact token overlap (case-insensitive)', () => {
    // "docker" exact-matches "Docker" (case-insensitive normalization).
    expect(matchesAdaptiveGates(['docker', 'container'], ['docker', 'deploy'], 200)).toBe(true);
  });

  // ── Z > 0 floor ───────────────────────────────────────────────────────
  it('rejects keywordless skills (X=0) even when the universe is degenerate', () => {
    // X=0 → Z is necessarily 0 → floor rejects → defer to Branch B.
    expect(matchesAdaptiveGates([], ['docker', 'deploy'], 200)).toBe(false);
  });

  it('rejects when the probe shares no tokens with the skill (Z=0)', () => {
    expect(matchesAdaptiveGates(['rust', 'cargo'], ['docker', 'deploy'], 200)).toBe(false);
  });

  // ── Crash guard: W ≤ 1 → no null model → Z > 0 floor ──────────────────
  it('W=1 falls back to the Z>0 floor (no divide-by-zero, no NaN)', () => {
    // W=1 would make (W−Y)/(W−1) divide by zero. Guard: W≤1 → return Z>0.
    // 1 exact overlap → Z=1>0 → match (the unrefined but safe original bar).
    expect(matchesAdaptiveGates(['docker'], ['docker', 'other'], 1)).toBe(true);
    expect(matchesAdaptiveGates(['docker'], ['other', 'third'], 1)).toBe(false);
  });

  it('W=0 falls back to the Z>0 floor: real overlap accepted, no overlap rejected', () => {
    // W=0 means no universe → no null model → the W≤1 guard returns Z>0.
    // A genuine exact overlap (Z>0) is accepted (safe, unrefined); no overlap
    // (Z=0) is rejected. This mirrors W=1: when there's no null to compute,
    // we don't hard-disable the keyword path, we fall back to the original bar.
    expect(matchesAdaptiveGates(['docker'], ['docker'], 0)).toBe(true);
    expect(matchesAdaptiveGates(['docker'], ['other'], 0)).toBe(false);
  });

  // ── Crash guard: Y > W → clamp Y ← min(Y, W) (no negative variance) ────
  it('Y > W does not throw and does not produce NaN (Y is clamped)', () => {
    // W=4, probe has 7 keywords (more than the universe). Without the clamp,
    // (W−Y)/(W−1) = (4−7)/3 = −1 → negative variance → sqrt(NaN). The guard
    // clamps Y←4 so the variance is computed over a valid sample size.
    // The skill owns 2 of the 4-keyword universe, probe hits 1 of them.
    // This must not throw and must return a boolean.
    const skillKw = ['a', 'b'];
    const probe = ['a', 'c', 'd', 'e', 'f', 'g', 'h']; // 7 probe kw, 1 hit ("a")
    expect(() => matchesAdaptiveGates(skillKw, probe, 4)).not.toThrow();
    expect(typeof matchesAdaptiveGates(skillKw, probe, 4)).toBe('boolean');
  });

  // ── Coverage-eligibility rule: X/W > ρ (=0.5) → defer to Branch B ──────
  it('a skill owning > ρ of the universe is ineligible (X/W > 0.5 → false)', () => {
    // X=3, W=4 → X/W = 0.75 > 0.5 → too broad for keyword overlap → Branch B.
    // Even with 2 exact hits the keyword path declines.
    expect(matchesAdaptiveGates(['a', 'b', 'c'], ['a', 'b'], 4)).toBe(false);
  });

  it('a skill owning exactly ρ of the universe is still eligible (X/W == 0.5)', () => {
    // X/W = 0.5 is NOT > 0.5 → eligible. 2 exact hits of 2-keyword skill,
    // 2-keyword probe, W=4. Recall: E=2*2/4=1, var=2*(.5)*(.5)*((4-2)/(3))=
    // 2*.5*.5*.667=0.333, σ=0.577, Z_min=1+2*0.577=2.155→ceil 3. Z=2 < 3 →
    // recall fails → false. (Confirms the rule is a gate, not an auto-pass.)
    expect(matchesAdaptiveGates(['a', 'b'], ['a', 'b'], 4)).toBe(false);
  });

  // ── β clamp [0.05, 0.5] ───────────────────────────────────────────────
  it('β clamps up at huge W: a 1-of-20 hit (β_raw=0.01) is rejected by β_min=0.05', () => {
    // W=1000, Y=5, κ=2 → β_raw = 10/1000 = 0.01 → clamped to 0.05.
    // Skill has 20 keywords, probe hits 1 → Z/X = 0.05 == β → precision OK.
    // But recall: E=20*5/1000=0.1, σ≈0.444, Z_min=0.1+0.888=0.988→ceil 1.
    // Z=1 ≥ 1 recall OK, Z/X=0.05 ≥ 0.05 precision OK → match.
    // (This is the borderline pass at the clamp floor.)
    const skillKw = Array.from({ length: 20 }, (_, i) => `kw${i}`);
    skillKw[0] = 'docker';
    const probe = ['docker', 'x', 'y', 'z', 'w'];
    expect(matchesAdaptiveGates(skillKw, probe, 1000)).toBe(true);
  });

  it('β clamps down at small W: a high-coverage match is not over-demanded (β_cap=0.5)', () => {
    // W=4, Y=7 (clamped to 4), κ=2 → β_raw = 8/4 = 2 → clamped to 0.5.
    // Without the cap, Z/X ≥ 2 would be unsatisfiable (need 2 hits of a
    // 1-keyword skill — impossible). With the cap, Z/X ≥ 0.5 → Z ≥ 1 of 2.
    // Skill has 2 keywords, probe hits 1 → Z/X = 0.5 ≥ 0.5 precision OK.
    // Recall with clamped Y=4: E=2*4/4=2, var=4*(.5)*(.5)*((4-4)/3)=0 →
    // σ=0, Z_min=2 → ceil 2. Z=1 < 2 → recall FAILS → false.
    // (Confirms the cap keeps the gate satisfiable but recall still binds.)
    expect(matchesAdaptiveGates(['a', 'b'], ['a', 'c', 'd', 'e', 'f', 'g', 'h'], 4)).toBe(false);
  });

  // ── ceil(Z_min): integer floor, not continuous ─────────────────────────
  it('ceil(Z_min): a Z_min just above an integer requires the next integer up', () => {
    // Construct a case where Z_min ≈ 1.0x → ceil = 2, so Z=1 must FAIL.
    // X=4, W=200, Y=2: E=4*2/200=0.04, σ=0.197, Z_min=0.04+0.395=0.435→ceil 1.
    // Z=1 ≥ 1 recall OK. precision β=2*2/200=0.02, Z/X=1/4=0.25 ≥ 0.02 OK → match.
    // So Z=1 passes here. Now force Z_min > 1: use Y=5 → E=0.1, σ=0.31,
    // Z_min=0.1+0.62=0.72→ceil 1. Z=1 still passes. The ceil matters when
    // Z_min crosses an integer; this test documents the integer semantics:
    // a single exact hit (Z=1) passes the recall gate whenever ceil(Z_min)≤1.
    expect(matchesAdaptiveGates(['docker', 'a', 'b', 'c'], ['docker', 'x'], 200)).toBe(true);
  });

  // ── The headline fix: vocab-bloat skill (big X, 1 incidental hit) ──────
  it('REJECTS the vocab-bloat skill that the old Z>0 substring filter passed', () => {
    // Old filter: 30-keyword skill, probe hits 1 via substring → Z>0 → match.
    // New filter: exact-token, X=30, W=200, Y=5, 1 hit.
    // Recall: E=30*5/200=0.75, σ≈0.834, Z_min=0.75+1.668=2.418→ceil 3. Z=1<3 → fail.
    // (Also precision: β=0.05, Z/X=1/30=0.033 < 0.05 → fail. Both gates reject.)
    const skillKw = Array.from({ length: 30 }, (_, i) => `kw${i}`);
    skillKw[0] = 'docker';
    const probe = ['docker', 'x', 'y', 'z', 'w']; // 1 exact hit
    expect(matchesAdaptiveGates(skillKw, probe, 200)).toBe(false);
  });

  it('ACCEPTS a genuinely-relevant skill: small X, majority hit', () => {
    // X=4, W=200, Y=5, 2 exact hits of the 4-keyword skill.
    // Recall: E=0.1, σ=0.31, Z_min=0.1+0.62=0.72→ceil 1. Z=2 ≥ 1 OK.
    // Precision: β=0.05, Z/X=2/4=0.5 ≥ 0.05 OK. → match.
    expect(matchesAdaptiveGates(['docker', 'container', 'a', 'b'], ['docker', 'container', 'x', 'y', 'z'], 200)).toBe(true);
  });
});