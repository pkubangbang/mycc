/**
 * prompt-budget.test.ts
 *
 * Token-footprint guards for all 5 system-prompt variants:
 *   - lead solo plan, lead team plan, lead solo normal, lead team normal, teammate
 *
 * Each prompt's estimated token count (via the project's built-in
 * `estimateTextTokens` from src/utils/token.ts) must stay within ±15% of a
 * pinned baseline. This keeps the system prompt from silently bloating the
 * context budget across future edits — a hard guardrail demanded by the
 * adversarial review of the agent-memory section work.
 *
 * The baseline values were measured after the agent-memory section landed
 * (replacing the old Checkpoint/recap + Knowledge Boundary sections with
 * buildLeadAgentMemorySection / buildTeammateAgentMemorySection). They are
 * intentionally pinned as constants so a regression test fails loudly rather
 * than drifting.
 *
 * No skill-keywords mocking is needed: the skill-keywords block moved to a
 * project-context populator (buildSkillKeywordsMessages in
 * prompt-populators.ts), so the system-prompt builders no longer touch the
 * loader — the prompts are environment-independent by construction.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { estimateTextTokens } from '../../utils/token.js';
import { buildPlanModePrompt, buildNormalModePrompt } from '../../loop/prompts/lead.js';

// ---------------------------------------------------------------------------
// Pinned baselines (measured with estimateTextTokens after agent-memory landed)
// ---------------------------------------------------------------------------

const BASELINES = {
  soloPlan: 7298,
  teamPlan: 8312,
  soloNormal: 6346,
  teamNormal: 8463,
  teammate: 6586,
} as const;

const TOLERANCE = 0.15; // ±15%

const WORK_DIR = 'C:\\Proj\\test';

describe('Prompt token budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('solo-plan prompt stays within ±15% of baseline', () => {
    const prompt = buildPlanModePrompt(WORK_DIR, false);
    const tokens = estimateTextTokens(prompt);
    const min = BASELINES.soloPlan * (1 - TOLERANCE);
    const max = BASELINES.soloPlan * (1 + TOLERANCE);
    expect(tokens).toBeGreaterThanOrEqual(min);
    expect(tokens).toBeLessThanOrEqual(max);
  });

  it('team-plan prompt stays within ±15% of baseline', () => {
    const prompt = buildPlanModePrompt(WORK_DIR, true);
    const tokens = estimateTextTokens(prompt);
    const min = BASELINES.teamPlan * (1 - TOLERANCE);
    const max = BASELINES.teamPlan * (1 + TOLERANCE);
    expect(tokens).toBeGreaterThanOrEqual(min);
    expect(tokens).toBeLessThanOrEqual(max);
  });

  it('solo-normal prompt stays within ±15% of baseline', () => {
    const prompt = buildNormalModePrompt(WORK_DIR, undefined, false);
    const tokens = estimateTextTokens(prompt);
    const min = BASELINES.soloNormal * (1 - TOLERANCE);
    const max = BASELINES.soloNormal * (1 + TOLERANCE);
    expect(tokens).toBeGreaterThanOrEqual(min);
    expect(tokens).toBeLessThanOrEqual(max);
  });

  it('team-normal prompt stays within ±15% of baseline', () => {
    const prompt = buildNormalModePrompt(WORK_DIR, undefined, true);
    const tokens = estimateTextTokens(prompt);
    const min = BASELINES.teamNormal * (1 - TOLERANCE);
    const max = BASELINES.teamNormal * (1 + TOLERANCE);
    expect(tokens).toBeGreaterThanOrEqual(min);
    expect(tokens).toBeLessThanOrEqual(max);
  });

  it('teammate prompt stays within ±15% of baseline', () => {
    const prompt = buildNormalModePrompt(WORK_DIR, { name: 'worker', role: 'coder' }, true);
    const tokens = estimateTextTokens(prompt);
    const min = BASELINES.teammate * (1 - TOLERANCE);
    const max = BASELINES.teammate * (1 + TOLERANCE);
    expect(tokens).toBeGreaterThanOrEqual(min);
    expect(tokens).toBeLessThanOrEqual(max);
  });

  it('agent-memory section is present in all 5 variants', () => {
    // The lead variants carry "## Agent Memory"; the teammate variant also
    // carries it (different content). All 5 must contain the heading.
    const soloPlan = buildPlanModePrompt(WORK_DIR, false);
    const teamPlan = buildPlanModePrompt(WORK_DIR, true);
    const soloNormal = buildNormalModePrompt(WORK_DIR, undefined, false);
    const teamNormal = buildNormalModePrompt(WORK_DIR, undefined, true);
    const teammate = buildNormalModePrompt(WORK_DIR, { name: 'worker', role: 'coder' }, true);

    for (const prompt of [soloPlan, teamPlan, soloNormal, teamNormal, teammate]) {
      expect(prompt).toContain('## Agent Memory');
    }
  });

  it('old sections are gone from all 5 variants', () => {
    // The old "## Checkpoint and recap" (Context Management) and
    // "## Knowledge Boundary" sections were merged into the agent-memory
    // section (or moved to a populator for the skill-keywords block), so no
    // prompt variant should carry either heading anymore.
    const soloPlan = buildPlanModePrompt(WORK_DIR, false);
    const teamPlan = buildPlanModePrompt(WORK_DIR, true);
    const soloNormal = buildNormalModePrompt(WORK_DIR, undefined, false);
    const teamNormal = buildNormalModePrompt(WORK_DIR, undefined, true);
    const teammate = buildNormalModePrompt(WORK_DIR, { name: 'worker', role: 'coder' }, true);

    for (const prompt of [soloPlan, teamPlan, soloNormal, teamNormal, teammate]) {
      expect(prompt).not.toContain('## Checkpoint and recap');
      expect(prompt).not.toContain('## Knowledge Boundary');
    }
  });
});