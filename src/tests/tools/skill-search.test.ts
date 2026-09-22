/**
 * skill-search.test.ts - Tests for the consolidated skill_search tool
 *
 * Covers the (search, semantic?) API:
 *   arg1 `search`   → extractKeywords (mocked here) → positional-points
 *                     scoreboard (weights [10,7,5,3,2], first-5-only).
 *   arg2 `semantic` → ctx.wiki.get (mocked) → boost(sim) = 1 + (sim - THR)
 *                     applied only when sim > THR, else boost = 1.0.
 *   score = points * boost; keep score > 10 STRICT; sort desc; top 3.
 *   points > 0 is the hard precondition (pure-semantic entry impossible).
 *
 * The LLM keyword-extraction call is mocked so tests are deterministic
 * (no real retryChat). The shared extractor's own behavior is exercised by
 * the collect-skill tests (peer-owned); here we assert the SCORING contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillSearchTool } from '../../tools/skill_search.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, Skill, SkillModule, WikiModule } from '../../types.js';

// ── Mocks ───────────────────────────────────────────────────────────────
// extractKeywords is the shared LLM primitive (src/loop/keyword-extractor.ts).
// Mock it so tests control the extracted keywords directly. The default
// mock returns success with empty keywords; each test overrides it.
vi.mock('../../loop/keyword-extractor.js', () => ({
  extractKeywords: vi.fn().mockResolvedValue({ status: 'success', keywords: [], freeformQuery: '' }),
}));

// Mock the loader singleton. `buildAllSkillEntries` returns the qualified
// "${scope}:${name}" titles the real loader produces (loader.buildSkillDocument
// → `title: \`${scope}:${name}\``), so the scope-aware identity mapping in
// scoreSkills is exercised on its REAL path (not the bare-name fallback).
// `currentScopeEntries` is a module-level mutable the tests set per-case.
let currentScopeEntries: Array<{ document: { title: string; content: string }; contentHash: string }> = [];

vi.mock('../../context/shared/loader.js', () => ({
  loader: {
    getSkillKeywords: vi.fn(() => []),
    getSkillLayer: vi.fn(() => 'project'),
    buildSkillIndexEntry: vi.fn(() => null),
    buildAllSkillEntries: vi.fn(() => currentScopeEntries),
  },
}));

// Mock config (threshold = 0.5 → boost neutral point at sim=0.5).
vi.mock('../../config.js', () => ({
  getSkillMatchThreshold: vi.fn(() => 0.5),
}));

// Import the mocked extractor so tests can override its return per-case.
import { extractKeywords } from '../../loop/keyword-extractor.js';

const mockedExtractKeywords = vi.mocked(extractKeywords);

/**
 * Create a mock AgentContext with mock SkillModule and WikiModule.
 */
function createMockContextWithSkills(
  workdir: string,
  skills: Skill[],
  wikiGetResult: Array<{ document: { title: string; content: string }; similarity: number; hash?: string }> = [],
): AgentContext {
  const skillModule: SkillModule = {
    loadSkills: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockReturnValue(skills),
    getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
    listAllTools: vi.fn().mockReturnValue([]),
    compileCondition: vi.fn().mockResolvedValue({}),
    replaceCondition: vi.fn().mockResolvedValue({ success: true }),
    buildSkillIndexEntry: vi.fn(() => null),
    buildAllSkillEntries: vi.fn(() => []),
  };

  const wikiModule: WikiModule = {
    get: vi.fn().mockResolvedValue(wikiGetResult),
    registerDomain: vi.fn().mockResolvedValue(undefined),
    indexSkills: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue({ accepted: true, hash: 'mock-hash' }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    getByDomain: vi.fn().mockResolvedValue([]),
    batchPut: vi.fn().mockResolvedValue([]),
    getWAL: vi.fn().mockResolvedValue([]),
    appendWAL: vi.fn().mockResolvedValue(undefined),
    rebuild: vi.fn().mockResolvedValue({ success: true, documentsProcessed: 0, errors: [] }),
    listDomains: vi.fn().mockResolvedValue([]),
    getDomain: vi.fn().mockResolvedValue(undefined),
  };

  const ctx = createMockContext(workdir);
  ctx.skill = skillModule;
  ctx.wiki = wikiModule;
  return ctx;
}

function createSampleSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'test-skill',
    description: 'A test skill for unit testing',
    keywords: ['test', 'example'],
    content: '# Test Skill\n\nThis is the content of the test skill.',
    ...overrides,
  };
}

/**
 * Build the qualified-title index entries the mocked loader's
 * `buildAllSkillEntries` returns, for the given skills under one scope.
 * Mirrors the real loader's `buildSkillDocument` title format
 * `${scope}:${name}`. Sets the module-level `currentScopeEntries` consumed
 * by the loader mock, so scoreSkills' scope-aware identity mapping runs on
 * its REAL path (matching qualified wiki titles to local qualified titles).
 */
function setLocalScope(skills: Skill[], scope: string): void {
  currentScopeEntries = skills.map(s => ({
    document: { title: `${scope}:${s.name}`, content: `Scope: ${scope}\nName: ${s.name}` },
    contentHash: 'hash',
  }));
}

/**
 * Build a wiki.get result entry under a given scope (the title the wiki
 * stored for a skill indexed by a process with that scope). Use this to
 * simulate a cross-project row in the shared `skills` domain.
 */
function wikiRow(name: string, scope: string, similarity: number) {
  return {
    document: { title: `${scope}:${name}`, content: `Scope: ${scope}\nName: ${name}` },
    similarity,
    hash: 'h',
  };
}

describe('skillSearchTool - Basics', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the extractor mock to the safe default before each test.
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: [], freeformQuery: '' });
    // Reset the loader's qualified-title entries (each test that needs the
    // scope-aware path calls setLocalScope explicitly).
    currentScopeEntries = [];
    ctx = createMockContextWithSkills('/tmp/test', []);
  });

  // =========================================================================
  // Metadata
  // =========================================================================

  it('should have correct tool metadata', () => {
    expect(skillSearchTool.name).toBe('skill_search');
    expect(skillSearchTool.description).toContain('Search skills by keywords');
    expect(skillSearchTool.scope).toEqual(['main', 'child']);
    expect(skillSearchTool.input_schema.required).toContain('search');
    expect(skillSearchTool.input_schema.properties).toHaveProperty('search');
    expect(skillSearchTool.input_schema.properties).toHaveProperty('semantic');
  });

  // =========================================================================
  // Positional scoring — weights [10,7,5,3,2]
  // =========================================================================

  it('scores a skill that owns the 1st keyword at weight 10 (above floor 10? strict >)', async () => {
    // 1 keyword (weight 10), no semantic boost → score = 10, which is NOT > 10
    // (strict), so it is gated out. This pins the STRICT > 10 boundary.
    const skills = [
      createSampleSkill({ name: 'review', keywords: ['code'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code' });

    expect(result).toContain("No skills found matching 'code'");
  });

  it('accumulates positional points when a skill owns multiple query keywords', async () => {
    // keywords: ['code','review'] → weights 10 + 7 = 17. No semantic → score 17 > 10.
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
      createSampleSkill({ name: 'unrelated', keywords: ['deploy'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('code-review');
    expect(result).toContain('Found 1 skill');
    expect(result).not.toContain('unrelated');
    // Score 17 should appear in the rendered header.
    expect(result).toContain('score 17');
  });

  it('applies positional weights by keyword ORDER, not by skill keyword position', async () => {
    // The 1st query keyword is worth 10. A skill owning only the 2nd keyword
    // earns 7 — below the strict > 10 floor → gated out.
    const skills = [
      createSampleSkill({ name: 'only-second', keywords: ['review'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain("No skills found matching 'code review'");
  });

  it('ignores query keywords beyond the 5th (only first 5 carry weight)', async () => {
    // 6 keywords; the 6th ('extra') is ignored. A skill owning only 'extra'
    // earns 0 points → never enters the scoreboard → not surfaced.
    const skills = [
      createSampleSkill({ name: 'extra-only', keywords: ['extra'] }),
      createSampleSkill({ name: 'first-kw', keywords: ['kw1'] }), // weight 10 → score 10, gated (strict)
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);
    mockedExtractKeywords.mockResolvedValue({
      status: 'success',
      keywords: ['kw1', 'kw2', 'kw3', 'kw4', 'kw5', 'extra'],
      freeformQuery: 'many',
    });

    const result = await skillSearchTool.handler(ctx, { search: 'many keywords' });

    // 'extra-only' must NOT appear (6th keyword ignored, 0 points).
    expect(result).not.toContain('extra-only');
    // 'first-kw' has 10 points (strict > 10 fails) → no skills found.
    expect(result).toContain("No skills found matching 'many keywords'");
  });

  // =========================================================================
  // Semantic boost — boost(sim) = 1 + (sim - THR), only when sim > THR
  // =========================================================================

  it('multiplies points by boost when similarity exceeds threshold', async () => {
    // 1 keyword weight 10 + semantic sim 0.7 → boost = 1 + (0.7 - 0.5) = 1.2
    // → score = 10 * 1.2 = 12 > 10 → surfaced. Uses the scope-aware path:
    // the local skill is indexed under "[user]:code-review" and the wiki row
    // carries that SAME qualified title, so the match resolves correctly.
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code'] }),
    ];
    setLocalScope(skills, '[user]');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('code-review', '[user]', 0.7),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code' });

    expect(result).toContain('code-review');
    expect(result).toContain('score 12');
    expect(result).toContain('x1.20 boost');
    expect(result).toContain('70% semantic');
  });

  it('keeps boost = 1.0 (NOT exclusion) when a keyword-matched skill misses the semantic window', async () => {
    // Skill owns the 1st keyword (weight 10) but wiki returns NO result for
    // its qualified title → boost = 1.0 → score = 10. Strict > 10 fails →
    // gated. Use 2 keywords (10 + 7 = 17) to clear the floor and assert boost
    // stays 1.0 (no boost tag). Uses the scope-aware path: local skill is
    // "[user]:code-review"; wiki returns an OTHER-scope same-named row, which
    // must NOT match (that is the scope-collision guard — covered explicitly
    // in the regression block below; here the wiki simply returns a different
    // bare skill under the local scope).
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    setLocalScope(skills, '[user]');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('other-skill', '[user]', 0.9),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('code-review');
    expect(result).toContain('score 17');
    // No boost tag (boost == 1.0) and no semantic pct for code-review.
    expect(result).not.toContain('x1.');
    expect(result).not.toContain('% semantic');
  });

  it('does NOT boost when similarity is at-or-below threshold (boost applied only when sim > THR)', async () => {
    // sim == threshold (0.5) exactly → boost NOT applied (strict >) → boost 1.0.
    // 2 keywords (17 pts) clear the floor; assert no boost tag.
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    setLocalScope(skills, '[user]');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('code-review', '[user]', 0.5),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('code-review');
    expect(result).toContain('score 17');
    expect(result).not.toContain('x1.');
  });

  // =========================================================================
  // points > 0 hard gate — pure-semantic entry is impossible
  // =========================================================================

  it('never surfaces a skill that matches ONLY semantically (no keyword match)', async () => {
    // Extraction yields keywords the skill does NOT own → 0 points → not in
    // scoreboard → even a 0.99 semantic similarity cannot surface it.
    const skills = [
      createSampleSkill({ name: 'semantic-only', description: 'No keyword overlap', keywords: ['unrelated'] }),
    ];
    setLocalScope(skills, '[user]');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('semantic-only', '[user]', 0.99),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain("No skills found matching 'code review'");
  });

  // =========================================================================
  // Ranking + top-N
  // =========================================================================

  it('ranks by score desc and returns at most SKILL_TOP_N (3)', async () => {
    // Four skills each owning the 1st keyword (weight 10). Add a 2nd keyword
    // to control relative points, plus semantic boosts to vary scores.
    const skills = [
      createSampleSkill({ name: 'a-top', keywords: ['code', 'review'] }),       // 10+7=17, sim 0.9 → *1.4 = 23.8
      createSampleSkill({ name: 'b-mid', keywords: ['code', 'review'] }),       // 17, sim 0.7 → *1.2 = 20.4
      createSampleSkill({ name: 'c-low', keywords: ['code', 'review'] }),       // 17, sim 0.6 → *1.1 = 18.7
      createSampleSkill({ name: 'd-out', keywords: ['code', 'review'] }),       // 17, no sim → 17
    ];
    setLocalScope(skills, '[user]');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('a-top', '[user]', 0.9),
      wikiRow('b-mid', '[user]', 0.7),
      wikiRow('c-low', '[user]', 0.6),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    // All four clear score > 10, but only top 3 are returned.
    expect(result).toContain('Found 3 skill');
    // Ordering: a-top (23.8) before b-mid (20.4) before c-low (18.7).
    const aPos = result.indexOf('a-top');
    const bPos = result.indexOf('b-mid');
    const cPos = result.indexOf('c-low');
    const dPos = result.indexOf('d-out');
    expect(aPos).toBeGreaterThan(-1);
    expect(bPos).toBeGreaterThan(aPos);
    expect(cPos).toBeGreaterThan(bPos);
    expect(dPos).toBe(-1); // 4th, truncated by top-3
  });

  // =========================================================================
  // Error / edge handling
  // =========================================================================

  it('handles empty search parameter', async () => {
    ctx = createMockContextWithSkills('/tmp/test', [createSampleSkill()]);
    const result = await skillSearchTool.handler(ctx, { search: '' });

    expect(result).toContain('ERROR: The "search" parameter is required and must be a non-empty string.');
  });

  it('handles search with only whitespace', async () => {
    ctx = createMockContextWithSkills('/tmp/test', [createSampleSkill()]);
    const result = await skillSearchTool.handler(ctx, { search: '   ' });

    expect(result).toContain('ERROR: The "search" parameter is required and must be a non-empty string.');
  });

  it('handles wiki.get failure gracefully (boost defaults to 1.0, keyword-only ranking)', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    const skillModule: SkillModule = {
      loadSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue(skills),
      getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
      listAllTools: vi.fn().mockReturnValue([]),
      compileCondition: vi.fn().mockResolvedValue({}),
      replaceCondition: vi.fn().mockResolvedValue({ success: true }),
      buildSkillIndexEntry: vi.fn(() => null),
      buildAllSkillEntries: vi.fn(() => []),
    };
    const wikiModule: WikiModule = {
      get: vi.fn().mockRejectedValue(new Error('Embedding model not available')),
      registerDomain: vi.fn().mockResolvedValue(undefined),
      indexSkills: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue({ accepted: true, hash: 'mock-hash' }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getByDomain: vi.fn().mockResolvedValue([]),
      batchPut: vi.fn().mockResolvedValue([]),
      getWAL: vi.fn().mockResolvedValue([]),
      appendWAL: vi.fn().mockResolvedValue(undefined),
      rebuild: vi.fn().mockResolvedValue({ success: true, documentsProcessed: 0, errors: [] }),
      listDomains: vi.fn().mockResolvedValue([]),
      getDomain: vi.fn().mockResolvedValue(undefined),
    };
    const ctx2 = createMockContext('/tmp/test');
    ctx2.skill = skillModule;
    ctx2.wiki = wikiModule;
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx2, { search: 'code review' });

    // Keyword points (17) still surface the skill; boost defaults to 1.0.
    expect(result).toContain('code-review');
    expect(result).toContain('Found 1 skill');
    expect(result).toContain('score 17');
  });

  it('reports no matches when extraction yields no keywords', async () => {
    ctx = createMockContextWithSkills('/tmp/test', [
      createSampleSkill({ name: 'code-review', keywords: ['code'] }),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: [], freeformQuery: '' });

    const result = await skillSearchTool.handler(ctx, { search: 'something vague' });

    expect(result).toContain("No skills found matching 'something vague'");
  });

  it('reports no matches when extraction is skipped (trivial query)', async () => {
    ctx = createMockContextWithSkills('/tmp/test', [
      createSampleSkill({ name: 'code-review', keywords: ['code'] }),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'skipped' });

    const result = await skillSearchTool.handler(ctx, { search: 'hello' });

    expect(result).toContain("No skills found matching 'hello'");
  });

  it('reports no matches when extraction fails (transient/abort)', async () => {
    ctx = createMockContextWithSkills('/tmp/test', [
      createSampleSkill({ name: 'code-review', keywords: ['code'] }),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'failed' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain("No skills found matching 'code review'");
  });

  it('calls brief with the match summary', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'skill_search', expect.stringContaining('code-review'), 'code review');
  });

  it('passes topK=50 (flat) to ctx.wiki.get', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    setLocalScope(skills, '[user]');
    ctx = createMockContextWithSkills('/tmp/test', skills);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(ctx.wiki.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ domain: 'skills', topK: 50, threshold: 0.5 }),
    );
  });

  // =========================================================================
  // P1 scope-collision regression (review #1)
  // The `skills` wiki domain is shared cross-project; wiki titles are
  // "${scope}:${name}". A same-named skill under ANOTHER scope must NOT have
  // its similarity applied to the locally-loaded skill. `[user]` and
  // `[built-in]` are constant scope strings on every machine, so a
  // user/built-in same-named skill collides with EVERY project's copy.
  // =========================================================================

  it('P1: does NOT apply another PROJECT scope\'s similarity to a local same-named skill', async () => {
    // Local process loaded "code-review" under scope "mycc". The wiki (shared
    // domain) also has "[user]:code-review" with a high similarity from a
    // DIFFERENT process. The local skill must keep boost 1.0 (not inherit
    // the [user] row's 0.9). Use 2 keywords (17 pts) to clear the floor.
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    setLocalScope(skills, 'mycc'); // local scope = project name "mycc"
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('code-review', '[user]', 0.9), // a DIFFERENT scope's row
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('code-review');
    // score must be 17 (points only, boost 1.0) — NOT 17 * 1.4 = 23.8.
    expect(result).toContain('score 17');
    expect(result).not.toContain('x1.');
    expect(result).not.toContain('% semantic');
  });

  it('P1: does NOT apply a [user] scope\'s similarity to a local [built-in] same-named skill', async () => {
    // [user] and [built-in] are CONSTANT scopes on every machine — the most
    // insidious collision. Local skill under [built-in]; wiki row under
    // [user] with sim 0.8. The [built-in] skill must NOT inherit it.
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    setLocalScope(skills, '[built-in]');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('code-review', '[user]', 0.8),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('code-review');
    expect(result).toContain('score 17'); // boost 1.0, not 1.3
    expect(result).not.toContain('x1.');
  });

  it('P1: DOES apply the matching scope\'s similarity (positive control)', async () => {
    // Same setup as the project-scope collision test, but the wiki row IS
    // under the local scope "mycc" → the boost MUST apply. This confirms the
    // fix does not over-restrict (a genuine same-scope match still boosts).
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code', 'review'] }),
    ];
    setLocalScope(skills, 'mycc');
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      wikiRow('code-review', 'mycc', 0.9),
    ]);
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: ['code', 'review'], freeformQuery: 'code review' });

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('code-review');
    // 17 * (1 + (0.9 - 0.5)) = 17 * 1.4 = 23.8
    expect(result).toContain('x1.40 boost');
    expect(result).toContain('90% semantic');
  });
});