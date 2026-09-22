/**
 * collect-keyword-integration.test.ts — Integration tests for the composite
 * keyword extraction (X+Y+Z) driving the REAL handleCollect().
 *
 * The companion file collect-keyword-discovery.test.ts tests the *modelled*
 * algorithm as pure functions. A review of PR #12 flagged that those pure-
 * function tests can pass while the production handleCollect() is wrong,
 * because they duplicate the logic in parallel helpers rather than exercising
 * the real code path. These tests close that gap: they drive the actual
 * handleCollect() with a mocked extractKeywords (and a passthrough escAware),
 * then assert the REAL TurnVars mutation — proving the production interaction
 *
 *   handleCollect → escAware → extractKeywords → throttle mutation
 *
 * behaves correctly for each KeywordExtractionResult variant:
 *   - success  → lastSkillY set + cooldown = 3
 *   - skipped  → lastSkillY set + cooldown = 3 (trivial query marked seen)
 *   - failed   → Y stays eligible (lastSkillY + cooldown UNCHANGED)
 *   - steering note → extraction → consumed → no duplicate re-trigger
 *
 * The mock harness mirrors collect-esc-hint.test.ts / collect-transient-retry
 * .test.ts: mock agent-io, esc-wrap-up, config (isVerbose→false), loader,
 * worktree-store, triologue (so the real
 * LLM call never fires — the mock controls the outcome). serve-registry is
 * mocked to drive the steering-note path; session/index is stubbed so
 * resolveHeadlessFirstQuery is a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KeywordExtractionResult } from '../../../loop/states/collect-skill.js';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => false),
    setNeglectedMode: vi.fn(),
    log: vi.fn(),
    verbose: vi.fn(),
    brief: vi.fn(),
  },
}));

vi.mock('../../../loop/esc-wrap-up.js', () => ({
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>();
  return { ...actual, isVerbose: vi.fn(() => false) };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: {
    getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]),
    // suggestSkill now passes loader.getSkillKeywords() into
    // extractKeywords; stub it so the COLLECT step 6 path resolves.
    getSkillKeywords: vi.fn(() => []),
  },
}));

vi.mock('../../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
}));

// extractKeywords is now a PRIVATE method on the SkillSuggester singleton
// (folded in from the former keyword-extractor.ts). The mock controls the
// extraction outcome so we can test each union variant without an LLM call.
// Since the method is private, the mock is installed via vi.spyOn on the
// shared singleton; a module-level `extractionResult` is reassigned per-test
// through the `setExtractionResult` helper, and the spy reads it at call
// time. `extractKeywordsSpy` exposes call-count assertions (replacing the
// old vi.mocked(extractKeywords) usage).
type ExtractKeywordsMock = ReturnType<typeof vi.fn<() => Promise<KeywordExtractionResult>>>;
let extractionResult: KeywordExtractionResult = { status: 'success', keywords: [], freeformQuery: '' };
let extractKeywordsSpy: ExtractKeywordsMock;

// serve-registry: module-level state drives isRunning/drainSteering so the
// steering-note path can be exercised. Defaults to NOT running (steering path
// skipped) — tests flip `serveRunning` + queue `steeredNotes` as needed.
let serveRunning = false;
let steeredNotes: string[] = [];
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(() => ({
    isRunning: () => serveRunning,
    drainSteering: () => {
      const out = steeredNotes;
      steeredNotes = [];
      return out;
    },
    drainFileUploads: () => [],
  })),
}));

// session/index: stub resolveHeadlessFirstQuery to a no-op (no session file).
vi.mock('../../../session/index.js', () => ({
  resolveHeadlessFirstQuery: vi.fn(() => false),
}));

// Triologue stub: the real handleCollect reads messages/tokens and injects
// notes. We keep it minimal — getConfusionIndex is mocked on ctx, so the hint
// block is skipped (confusion 0), keeping the test focused on step 6.
vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    note = vi.fn();
    agent = vi.fn();
    tool = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getMessages = vi.fn(() => []);
    setSystemPrompt = vi.fn();
    generateHintRound = vi.fn();
    compact = vi.fn(async () => {});
    getTokenCount = vi.fn(() => 100);
    getTokenThreshold = vi.fn(() => 50000);
    getLastRole = vi.fn(() => null);
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleCollect } from '../../../loop/states/collect.js';
import { AgentState } from '../../../loop/state-machine.js';
import { Triologue } from '../../../loop/triologue.js';
import { skillSuggester, beginFreshSession } from '../../../loop/states/collect-skill.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
} from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';
import type { TurnVars } from '../../../loop/state-machine.js';

/**
 * Configure the mocked extractKeywords to return the given result. Installs a
 * fresh vi.fn on the singleton's (private) method each call so prior tests'
 * mocks never leak. The fn resolves to the CURRENT `extractionResult` at call
 * time (re-read from the closure), so a per-test `setExtractionResult` after
 * the fn is installed still takes effect.
 *
 * Uses `vi.fn` + direct assignment rather than `vi.spyOn` because the method
 * is private: `vi.spyOn(obj, 'privateMethod' as never)` collapses the spy
 * type to `never` under the strict test tsconfig, so `.mockImplementation`
 * fails to typecheck. A plain `vi.fn` assigned via bracket access keeps a
 * concrete `Mock` type and is restored in afterEach via `vi.restoreAllMocks`
 * (skipped here — the singleton is long-lived and reassignment per-test is
 * the intended lifecycle; `mockClear` resets call state between tests).
 */
function setExtractionResult(result: KeywordExtractionResult): void {
  extractionResult = result;
  extractKeywordsSpy = vi.fn(async () => extractionResult);
  (skillSuggester as unknown as Record<string, unknown>).extractKeywords = extractKeywordsSpy;
}

describe('handleCollect — composite keyword extraction (integration)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level mock state to safe defaults and install a fresh
    // spy on the (now-private) extractKeywords method. Each setExtractionResult
    // call re-installs the spy with the new return value.
    extractionResult = { status: 'success', keywords: [], freeformQuery: '' };
    extractKeywordsSpy = vi.fn(async () => extractionResult);
    (skillSuggester as unknown as Record<string, unknown>).extractKeywords = extractKeywordsSpy;
    serveRunning = false;
    steeredNotes = [];
    // Reset the skill-discovery singleton's throttle state so prior tests'
    // query cursor / cooldown never leak into this one.
    skillSuggester.reset();
    triologue = new Triologue();
  });

  /**
   * Build a env wired for the keyword-extraction path: low confusion (hint
   * block skipped), no todos (nudge skipped), escAware runs the operation
   * (passthrough — no ESC). The skill layer returns no skills so even a
   * successful extraction with keywords injects no HINT note, keeping the
   * assertion focused on TurnVars mutation.
   */
  function makeEnv() {
    const ctx = createMockContext({
      core: {
        getConfusionIndex: vi.fn(() => 0), // below threshold → hint block skipped
        brief: vi.fn(),
        verbose: vi.fn(),
      } as never,
      skill: { listSkills: vi.fn(() => []) } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    // Passthrough escAware: run the operation with a real AbortController.
    env.ctx.core.escAware = vi.fn(async (operation: (ac: AbortController) => Promise<unknown>) => {
      return await operation(new AbortController());
    }) as never;
    return env;
  }

  /**
   * Build an env wired for the BRANCHING skill-suggestion tests: low
   * confusion (hint block skipped), no todos, passthrough escAware, BUT with
   * a populated skill list (so keyword matching produces matches) and a
   * configurable wiki.get mock (so Branch B's semantic intersection can be
   * exercised). `wikiResults` is an array of { title, similarity } shaping
   * the ctx.wiki.get return; `wikiThrow` makes wiki.get reject (to test the
   * graceful-failure path).
   *
   * Every skill is given the keyword 'test' so a single extracted keyword
   * 'test' matches all of them — driving the oversize branch when >= 6
   * skills are provided.
   */
  function makeEnvWithSkills(
    skills: Array<{ name: string; description?: string; keywords?: string[] }>,
    wikiResults: Array<{ title: string; similarity?: number }> = [],
    wikiThrow = false,
  ) {
    const fullSkills = skills.map(s => ({
      name: s.name,
      description: s.description ?? '',
      keywords: s.keywords ?? ['test'],
      content: '',
    }));
    const ctx = createMockContext({
      core: {
        getConfusionIndex: vi.fn(() => 0),
        brief: vi.fn(),
        verbose: vi.fn(),
      } as never,
      skill: { listSkills: vi.fn(() => fullSkills) } as never,
      wiki: {
        get: wikiThrow
          ? vi.fn(async () => { throw new Error('embedding model unavailable'); })
          : vi.fn(async () => wikiResults.map(r => ({
              document: { title: r.title, content: '', references: [] },
              similarity: r.similarity ?? 0.8,
              hash: 'h',
            }))),
      } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    env.ctx.core.escAware = vi.fn(async (operation: (ac: AbortController) => Promise<unknown>) => {
      return await operation(new AbortController());
    }) as never;
    return env;
  }

  /** Build N skills all matching the keyword 'test' (name = skill-<i>). */
  function makeOversizeSkills(n: number): Array<{ name: string; description?: string }> {
    return Array.from({ length: n }, (_, i) => ({
      name: `skill-${i}`,
      description: `Skill number ${i}`,
    }));
  }

  // ---------------------------------------------------------------------------
  // success path
  // ---------------------------------------------------------------------------

  it('SUCCESS: arms lastSkillY + cooldown=3 and consumes extractKeywords once', async () => {
    setExtractionResult({ status: 'success', keywords: ['parser', 'test'], freeformQuery: '' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
    });

    await handleCollect(env, turn, createChatData());

    expect(skillSuggester.getLastQuery()).toBe('help me test the parser');
    expect(skillSuggester.getCooldown()).toBe(3);
    expect(extractKeywordsSpy).toHaveBeenCalledTimes(1);
  });

  it('SUCCESS with empty keywords still arms the cooldown (op completed)', async () => {
    setExtractionResult({ status: 'success', keywords: [], freeformQuery: '' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'some query with no skill match',
    });

    await handleCollect(env, turn, createChatData());

    expect(skillSuggester.getLastQuery()).toBe('some query with no skill match');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // skipped path (trivial query)
  // ---------------------------------------------------------------------------

  it('SKIPPED: marks Y as seen + cooldown=3 (trivial query does not loop)', async () => {
    setExtractionResult({ status: 'skipped' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'hello',
    });

    await handleCollect(env, turn, createChatData());

    expect(skillSuggester.getLastQuery()).toBe('hello');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // failed path (ESC / transient) — the P1 fix
  // ---------------------------------------------------------------------------

  it('FAILED: does NOT arm lastSkillY or cooldown (Y stays eligible for retry)', async () => {
    setExtractionResult({ status: 'failed' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
    });

    await handleCollect(env, turn, createChatData());

    // Neither field is touched — the discovery opportunity is preserved.
    expect(skillSuggester.getLastQuery()).toBe('');
    expect(skillSuggester.getCooldown()).toBe(0);
  });

  it('FAILED: a second pass with the same Y re-triggers extraction (retry works)', async () => {
    setExtractionResult({ status: 'failed' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
    });

    // Pass 1: fails, leaves query eligible.
    await handleCollect(env, turn, createChatData());
    expect(extractKeywordsSpy).toHaveBeenCalledTimes(1);
    expect(skillSuggester.getLastQuery()).toBe('');
    expect(skillSuggester.getCooldown()).toBe(0);

    // Pass 2: same query, no cooldown, lastQuery still '' → extraction fires again.
    extractKeywordsSpy.mockClear();
    await handleCollect(env, turn, createChatData());
    expect(extractKeywordsSpy).toHaveBeenCalledTimes(1);
  });

  it('FAILED via ESC cleanup: escAware cleanup returns {status:"failed"} → retry eligible', async () => {
    // Simulate ESC: escAware runs the cleanup branch (returns {status:'failed'})
    // instead of the operation. This proves the ESC path — which the old []
    // API silently broke — now preserves retry eligibility.
    const env = makeEnv();
    env.ctx.core.escAware = vi.fn(async (_operation: unknown, cleanup: () => unknown) => {
      return cleanup() as KeywordExtractionResult;
    }) as never;
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
    });

    await handleCollect(env, turn, createChatData());

    expect(skillSuggester.getLastQuery()).toBe('');
    expect(skillSuggester.getCooldown()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // gating: no extraction when Y unchanged or cooldown active
  // ---------------------------------------------------------------------------

  it('does NOT call extractKeywords when Y is unchanged (lastSkillY === Y)', async () => {
    setExtractionResult({ status: 'success', keywords: [], freeformQuery: '' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'same query',
    });
    skillSuggester.markQuerySeen('same query'); // already seen

    await handleCollect(env, turn, createChatData());

    expect(extractKeywordsSpy).not.toHaveBeenCalled();
  });

  it('does NOT call extractKeywords when cooldown > 0', async () => {
    setExtractionResult({ status: 'success', keywords: [], freeformQuery: '' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'a new query',
    });
    skillSuggester.markQuerySeen('old query'); // Y changed
    skillSuggester.armCooldown();               // cooldown active (3)
    // The top of step 6 decrements cooldown once, so it reads 2 here.

    await handleCollect(env, turn, createChatData());

    expect(extractKeywordsSpy).not.toHaveBeenCalled();
    // Cooldown was decremented once at the top of step 6.
    expect(skillSuggester.getCooldown()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // steering-note path (BUG 1 — no spurious double-trigger)
  // ---------------------------------------------------------------------------

  it('STEERING NOTE: triggers on the note, marks the fallback lastUserQuery as seen', async () => {
    setExtractionResult({ status: 'success', keywords: ['tests'], freeformQuery: '' });
    serveRunning = true;
    steeredNotes = ['focus on tests'];
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'original user query',
    });

    await handleCollect(env, turn, createChatData());

    // BUG 1 fix: lastQuery is the FALLBACK (lastUserQuery), not the steering
    // note, so the consumed-note → fallback re-trigger does not fire.
    expect(skillSuggester.getLastQuery()).toBe('original user query');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('STEERING NOTE consumed: a second pass with no note does NOT re-trigger', async () => {
    setExtractionResult({ status: 'success', keywords: ['tests'], freeformQuery: '' });
    serveRunning = true;
    steeredNotes = ['focus on tests'];
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'original user query',
    });

    // Pass 1: steering note triggers, applies BUG 1 fix.
    await handleCollect(env, turn, createChatData());
    expect(skillSuggester.getLastQuery()).toBe('original user query');
    expect(skillSuggester.getCooldown()).toBe(3);

    // Drain cooldown over passes 2, 3, 4 (no steering notes queued).
    steeredNotes = [];
    extractKeywordsSpy.mockClear();
    for (let i = 0; i < 3; i++) {
      await handleCollect(env, turn, createChatData());
    }
    expect(skillSuggester.getCooldown()).toBe(0);

    // Pass 5: steering note is consumed (serveRunning but no notes). Y falls
    // back to lastUserQuery, which equals lastQuery → NO re-trigger.
    extractKeywordsSpy.mockClear();
    const result = await handleCollect(env, turn, createChatData());
    expect(extractKeywordsSpy).not.toHaveBeenCalled();
    expect(result).toBe(AgentState.LLM);
  });

  // ---------------------------------------------------------------------------
  // sanity: handleCollect still returns LLM on the extraction path
  // ---------------------------------------------------------------------------

  it('returns LLM after a successful extraction pass', async () => {
    setExtractionResult({ status: 'success', keywords: ['x'], freeformQuery: '' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
    });

    const result = await handleCollect(env, turn, createChatData());
    expect(result).toBe(AgentState.LLM);
  });

  // ---------------------------------------------------------------------------
  // Branching skill suggestion (Branch A small / Branch B oversize)
  // ---------------------------------------------------------------------------

  it('BRANCH A (small match <5): injects the full keyword-matched list, no wiki call', async () => {
    // 3 skills match keyword 'test' → below the oversize threshold (5).
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = makeOversizeSkills(3);
    const env = makeEnvWithSkills(skills);
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test things',
    });

    await handleCollect(env, turn, createChatData());

    // HINT injected with all 3 matched skills (new → name + description).
    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('skill-0'));
    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('skill-2'));
    // Branch A does NOT call wiki.get (no semantic refinement needed).
    expect(env.ctx.wiki.get).not.toHaveBeenCalled();
    // Y marked + cooldown armed (full success).
    expect(skillSuggester.getLastQuery()).toBe('help me test things');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('BRANCH B at exactly the threshold (==5): takes the oversize path (boundary)', async () => {
    // Boundary probe: the branch is `matched.length < SKILL_OVERSIZE_THRESHOLD`
    // so 5 matched skills is NOT < 5 → it takes Branch B (wiki intersection).
    // The existing tests probe 3 and 6; this pins the exact boundary at 5.
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = makeOversizeSkills(5); // skill-0 .. skill-4 — exactly the threshold
    const wikiResults = [
      { title: 'project:skill-0', similarity: 0.9 },
      { title: 'project:skill-2', similarity: 0.8 },
    ];
    const env = makeEnvWithSkills(skills, wikiResults);
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test exactly five matches',
    });

    await handleCollect(env, turn, createChatData());

    // Branch B ran → wiki.get was called (Branch A would NOT call it).
    expect(env.ctx.wiki.get).toHaveBeenCalledWith(
      'test automation',
      expect.objectContaining({ domain: 'skills', topK: 10 }),
    );
    // Only the intersection (skill-0, skill-2) is surfaced; the other three
    // keyword-only matches are filtered out.
    const hintCall = vi.mocked(triologue.note).mock.calls.find(c => c[0] === 'HINT');
    const hintContent = hintCall ? String(hintCall[1]) : '';
    expect(hintContent).toContain('skill-0');
    expect(hintContent).toContain('skill-2');
    expect(hintContent).not.toContain('skill-1');
    expect(hintContent).not.toContain('skill-3');
    expect(hintContent).not.toContain('skill-4');
  });

  it('BRANCH B (oversize >=5): injects ONLY the keyword∩semantic intersection', async () => {
    // 6 skills match → oversize. Wiki returns 2 of them semantically.
    // Intersection = the 2 overlapping skills → HINT contains only those.
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = makeOversizeSkills(6); // skill-0 .. skill-5
    const wikiResults = [
      { title: 'project:skill-1', similarity: 0.9 },
      { title: 'project:skill-4', similarity: 0.8 },
      { title: 'project:unrelated-skill', similarity: 0.7 },
    ];
    const env = makeEnvWithSkills(skills, wikiResults);
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the oversize case',
    });

    await handleCollect(env, turn, createChatData());

    // wiki.get was called with the freeform query.
    expect(env.ctx.wiki.get).toHaveBeenCalledWith(
      'test automation',
      expect.objectContaining({ domain: 'skills', topK: 10 }),
    );
    // HINT contains the 2 intersection skills...
    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('skill-1'));
    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('skill-4'));
    // ...but NOT the 4 keyword-only-matched skills.
    const hintCall = vi.mocked(triologue.note).mock.calls.find(c => c[0] === 'HINT');
    const hintContent = hintCall ? String(hintCall[1]) : '';
    expect(hintContent).not.toContain('skill-0');
    expect(hintContent).not.toContain('skill-5');
    expect(hintContent).not.toContain('unrelated-skill');
    // Y marked + cooldown armed.
    expect(skillSuggester.getLastQuery()).toBe('help me test the oversize case');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('BRANCH B (oversize, empty intersection): NO hint injected', async () => {
    // 6 skills match → oversize. Wiki returns only unrelated skills →
    // intersection empty → no HINT.
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = makeOversizeSkills(6);
    const wikiResults = [
      { title: 'project:totally-unrelated', similarity: 0.9 },
      { title: 'project:also-unrelated', similarity: 0.8 },
    ];
    const env = makeEnvWithSkills(skills, wikiResults);
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test with no intersection',
    });

    await handleCollect(env, turn, createChatData());

    // wiki was called...
    expect(env.ctx.wiki.get).toHaveBeenCalled();
    // ...but NO HINT note was injected (empty intersection → silent).
    const hintCalls = vi.mocked(triologue.note).mock.calls.filter(c => c[0] === 'HINT');
    expect(hintCalls).toHaveLength(0);
    // Y still marked + cooldown armed (the extraction itself succeeded;
    // only the refinement produced no suggestion).
    expect(skillSuggester.getLastQuery()).toBe('help me test with no intersection');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('BRANCH B (oversize, wiki failure): NO hint injected (graceful)', async () => {
    // 6 skills match → oversize. wiki.get throws → no hint.
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = makeOversizeSkills(6);
    const env = makeEnvWithSkills(skills, [], true /* wikiThrow */);
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test with wiki down',
    });

    await handleCollect(env, turn, createChatData());

    // wiki.get was attempted...
    expect(env.ctx.wiki.get).toHaveBeenCalled();
    // ...but NO HINT note (semantic search unavailable → silent).
    const hintCalls = vi.mocked(triologue.note).mock.calls.filter(c => c[0] === 'HINT');
    expect(hintCalls).toHaveLength(0);
    // Y still marked + cooldown armed.
    expect(skillSuggester.getLastQuery()).toBe('help me test with wiki down');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('BRANCH B (oversize, empty freeformQuery): FAIL FAST — no hint, Y eligible for retry', async () => {
    // 6 skills match → oversize. But freeformQuery is empty → fail fast.
    // Y must NOT be marked and cooldown must NOT be armed (retry eligible).
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: '' });
    const skills = makeOversizeSkills(6);
    const env = makeEnvWithSkills(skills);
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test with bad query',
    });

    await handleCollect(env, turn, createChatData());

    // wiki.get was NOT called (fail fast before the semantic step).
    expect(env.ctx.wiki.get).not.toHaveBeenCalled();
    // NO HINT injected.
    const hintCalls = vi.mocked(triologue.note).mock.calls.filter(c => c[0] === 'HINT');
    expect(hintCalls).toHaveLength(0);
    // FAIL FAST: Y NOT marked + cooldown NOT armed → retry eligible next pass.
    expect(skillSuggester.getLastQuery()).toBe('');
    expect(skillSuggester.getCooldown()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // P1 regression: fresh-session clear (double-Ctrl+L / /clear) must not
  // re-fire extraction on the cleared turn's stale composite sources.
  // ---------------------------------------------------------------------------

  it('P1: a fresh-session clear prevents extraction on the next COLLECT (stale lastUserQuery)', async () => {
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me refactor the parser',
      lastBriefMessage: 'debugging the parser module',
      lastHintFocus: 'parser refactor',
    });

    // Pass 1: a genuine query triggers extraction and arms the throttle, so
    // the suggester's cursor now equals the turn's lastUserQuery.
    await handleCollect(env, turn, createChatData());
    expect(extractKeywordsSpy).toHaveBeenCalledTimes(1);
    expect(skillSuggester.getLastQuery()).toBe('help me refactor the parser');

    // The user clears the conversation (double-Ctrl+L / /clear): the
    // fresh-session primitive resets the suggester AND invalidates the
    // turn's composite sources.
    beginFreshSession(turn);

    // Next COLLECT: the triologue is empty and the turn sources are cleared,
    // so querySource is null → NO extraction. Resetting the suggester alone
    // would have left lastUserQuery populated → a spurious re-fire here.
    extractKeywordsSpy.mockClear();
    const result = await handleCollect(env, turn, createChatData());

    expect(extractKeywordsSpy).not.toHaveBeenCalled();
    expect(result).toBe(AgentState.LLM);
  });

  it('P1 counter-check: WITHOUT the fix, resetting the suggester alone re-fires extraction', async () => {
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me refactor the parser',
    });

    await handleCollect(env, turn, createChatData());
    expect(extractKeywordsSpy).toHaveBeenCalledTimes(1);

    // The OLD (buggy) clear: reset the suggester cursor, but leave the turn's
    // lastUserQuery stale. The suggester cursor is now '' while the turn still
    // reports the old query → queryChanged is true → extraction re-fires on
    // context the user just cleared.
    skillSuggester.reset();

    extractKeywordsSpy.mockClear();
    await handleCollect(env, turn, createChatData());

    expect(extractKeywordsSpy).toHaveBeenCalledTimes(1);
  });
});