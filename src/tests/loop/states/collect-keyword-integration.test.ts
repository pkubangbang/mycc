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
import type { KeywordExtractionResult } from '../../../loop/keyword-extractor.js';

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
    // scoreSkills (shared scorer) maps each local skill to its qualified
    // wiki title (${scope}:${name}) via buildAllSkillEntries(). The tests use
    // the scope 'project', so stub entries with 'project:<name>' titles.
    // Tests that need a different scope override this via the helper below.
    buildAllSkillEntries: vi.fn(() => []),
  },
}));

vi.mock('../../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
}));

// extractKeywords is the SHARED extractor (src/loop/keyword-extractor.ts),
// imported by collect-skill.ts as a module binding. Mock the module so the
// extraction outcome is controlled without an LLM call, and so we can assert
// call counts (replacing the old private-method spy on the singleton, which
// no longer exists — the method was folded out into the shared module).
vi.mock('../../../loop/keyword-extractor.js', () => ({
  extractKeywords: vi.fn().mockResolvedValue({ status: 'success', keywords: [], freeformQuery: '' }),
}));

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
import { extractKeywords } from '../../../loop/keyword-extractor.js';
import { loader } from '../../../context/shared/loader.js';

/** The module-level mock of the shared extractor (call-count assertions). */
const mockedExtractKeywords = vi.mocked(extractKeywords);

/**
 * Configure the mocked extractKeywords to return the given result. Uses
 * mockResolvedValue on the module mock so every call in the test resolves to
 * this outcome; mockClear in beforeEach resets call state between tests.
 */
function setExtractionResult(result: KeywordExtractionResult): void {
  mockedExtractKeywords.mockResolvedValue(result);
}

describe('handleCollect — composite keyword extraction (integration)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the extractor mock to a safe default (success, no keywords) and
    // clear its call state; each setExtractionResult overrides the outcome.
    mockedExtractKeywords.mockReset();
    mockedExtractKeywords.mockResolvedValue({ status: 'success', keywords: [], freeformQuery: '' });
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
    scope = 'project',
  ) {
    const fullSkills = skills.map(s => ({
      name: s.name,
      description: s.description ?? '',
      keywords: s.keywords ?? ['test'],
      content: '',
    }));
    // scoreSkills maps local skills to their qualified wiki titles; mirror
    // the chosen scope so wiki rows (built by the caller) can match.
    vi.mocked(loader.buildAllSkillEntries).mockReturnValue(
      fullSkills.map(s => ({
        document: {
          domain: 'skills',
          title: `${scope}:${s.name}`,
          content: '',
          references: [],
        },
        contentHash: 'h',
      })),
    );
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
    setExtractionResult({ status: 'success', keywords: ['parser', 'test'], freeformQuery: 'parser testing' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
    });

    await handleCollect(env, turn, createChatData());

    expect(skillSuggester.getLastQuery()).toBe('help me test the parser');
    expect(skillSuggester.getCooldown()).toBe(3);
    expect(mockedExtractKeywords).toHaveBeenCalledTimes(1);
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

    expect(mockedExtractKeywords).not.toHaveBeenCalled();
  });


  // ---------------------------------------------------------------------------
  // steering-note path (BUG 1 — no spurious double-trigger)
  // ---------------------------------------------------------------------------

  it('STEERING NOTE: triggers on the note, marks the fallback lastUserQuery as seen', async () => {
    setExtractionResult({ status: 'success', keywords: ['tests'], freeformQuery: 'running tests' });
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
  // Ranking / top-3 injection (positional points × semantic boost)
  // ---------------------------------------------------------------------------

  it('RANKING: injects the top-3 scored skills, ordered by score', async () => {
    // 4 skills, all owning the single query keyword 'test' (1st position =
    // 10 pts). Wiki awards skill-3 a 0.9 similarity (boost 1.4 → 14.0),
    // skill-0 a 0.7 (boost 1.2 → 12.0); skill-1/2 get no similarity
    // (boost 1.0 → 10.0, which does NOT clear the strict >10 gate).
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = makeOversizeSkills(4);
    const wikiResults = [
      { title: 'project:skill-3', similarity: 0.9 },
      { title: 'project:skill-0', similarity: 0.7 },
    ];
    const env = makeEnvWithSkills(skills, wikiResults, false, 'project');
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'help me test things' });

    await handleCollect(env, turn, createChatData());

    // wiki.get called with the freeform query + the FLAT topK=50 window.
    expect(env.ctx.wiki.get).toHaveBeenCalledWith(
      'test automation',
      expect.objectContaining({ domain: 'skills', topK: 50 }),
    );
    // The two boosted skills clear the floor; the two unboosted (10.0) do not.
    const hintCall = vi.mocked(triologue.note).mock.calls.find(c => c[0] === 'HINT');
    expect(hintCall).toBeDefined();
    const hintContent = hintCall ? String(hintCall[1]) : '';
    expect(hintContent).toContain('skill-3');
    expect(hintContent).toContain('skill-0');
    expect(hintContent).not.toContain('skill-1');
    expect(hintContent).not.toContain('skill-2');
    // Y marked + cooldown armed (full success).
    expect(skillSuggester.getLastQuery()).toBe('help me test things');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('RANKING: a keyword-strong match passes with NO wiki hit (boost 1.0, strict gate)', async () => {
    // 1st + 2nd keywords = 17 pts. No semantic row → boost 1.0 → 17 > 10,
    // so the keyword signal alone surfaces the skill (soft boost never
    // EXCLUDES a keyword-matched skill).
    setExtractionResult({
      status: 'success',
      keywords: ['restart', 'mycc'],
      freeformQuery: 'restart the mycc instance',
    });
    const skills = [{ name: 'mycc-online-hotfix', description: 'Hotfix', keywords: ['restart', 'mycc'] }];
    const env = makeEnvWithSkills(skills); // wiki returns no rows
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'restart my mycc instance' });

    await handleCollect(env, turn, createChatData());

    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('mycc-online-hotfix'));
  });

  it('RANKING: a weak 7-pt match needs a strong semantic hit to pass', async () => {
    // 2nd-position keyword only = 7 pts. A 0.9 similarity (boost 1.4) gives
    // 9.8, which does NOT clear the strict >10 gate → no HINT.
    setExtractionResult({
      status: 'success',
      keywords: ['foo', 'bar'],
      freeformQuery: 'bar handling',
    });
    const skills = [{ name: 'weak-match', description: 'W', keywords: ['bar'] }];
    const env = makeEnvWithSkills(skills, [{ title: 'project:weak-match', similarity: 0.9 }]);
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'tell me about bar' });

    await handleCollect(env, turn, createChatData());

    expect(triologue.note).not.toHaveBeenCalledWith('HINT', expect.anything());
  });

  it('RANKING: a pure-semantic skill (0 keyword points) can NEVER surface', async () => {
    // The skill matches NO query keyword → points 0 → 0 × boost = 0, so it
    // never clears the floor even with a perfect 1.0 similarity.
    setExtractionResult({ status: 'success', keywords: ['alpha'], freeformQuery: 'alpha work' });
    const skills = [{ name: 'semantic-only', description: 'S', keywords: ['unrelated'] }];
    const env = makeEnvWithSkills(skills, [{ title: 'project:semantic-only', similarity: 1.0 }]);
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'do alpha work' });

    await handleCollect(env, turn, createChatData());

    expect(triologue.note).not.toHaveBeenCalledWith('HINT', expect.anything());
  });

  it('RANKING: wiki failure degrades to keyword-only ranking (no throw)', async () => {
    // wiki.get throws → every boost = 1.0; a 17-pt keyword match still passes.
    setExtractionResult({
      status: 'success',
      keywords: ['restart', 'mycc'],
      freeformQuery: 'restart the mycc instance',
    });
    const skills = [{ name: 'mycc-online-hotfix', description: 'Hotfix', keywords: ['restart', 'mycc'] }];
    const env = makeEnvWithSkills(skills, [], /* wikiThrow */ true);
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'restart my mycc instance' });

    await handleCollect(env, turn, createChatData());

    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('mycc-online-hotfix'));
  });

  it('P1 SCOPE: another scope\'s wiki row does NOT boost the local same-named skill', async () => {
    // End-to-end through handleCollect: the local process holds skill-0 under
    // scope 'project'; the wiki returns a row for the SAME bare name under a
    // DIFFERENT scope with a high similarity. Before the P1 fix (bare-name
    // keying) that row would boost the local skill; after the fix the
    // qualified titles differ → no boost → 10 pts stays AT the floor → dropped
    // → no HINT at all. A positive control with the matching scope is covered
    // in collect-skill-scoring.test.ts.
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = [{ name: 'code-review', description: 'Review', keywords: ['test'] }];
    // Local scope is 'project', but the wiki row is '[user]' — same bare name.
    const env = makeEnvWithSkills(skills, [{ title: '[user]:code-review', similarity: 0.92 }], false, 'project');
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'help me test things' });

    await handleCollect(env, turn, createChatData());

    // No boost applied → 10 pts is NOT > 10 → nothing surfaces → no HINT.
    expect(triologue.note).not.toHaveBeenCalledWith('HINT', expect.anything());
  });

  it('P1 SCOPE positive control: the MATCHING scope\'s row DOES boost (HINT injected)', async () => {
    // Same as above but the wiki row's scope matches the local skill's, so the
    // 0.9 similarity boosts 10 pts → 10 × 1.5 = 15 > 10 → the skill surfaces.
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: 'test automation' });
    const skills = [{ name: 'code-review', description: 'Review', keywords: ['test'] }];
    const env = makeEnvWithSkills(skills, [{ title: 'project:code-review', similarity: 1.0 }], false, 'project');
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'help me test things' });

    await handleCollect(env, turn, createChatData());

    expect(triologue.note).toHaveBeenCalledWith('HINT', expect.stringContaining('code-review'));
  });

  // ---------------------------------------------------------------------------
  // Fail-fast: empty freeformQuery clears the throttle (retry-eligible)
  // ---------------------------------------------------------------------------

  it('fail-fast: an empty freeformQuery clears the throttle and injects no HINT', async () => {
    // A success outcome that carries keywords but NO freeformQuery cannot run
    // the semantic phase → clearThrottle() undoes the mark-seen + cooldown so
    // the next pass re-attempts extraction (the query stays eligible).
    setExtractionResult({ status: 'success', keywords: ['test'], freeformQuery: '' });
    const skills = makeOversizeSkills(3);
    const env = makeEnvWithSkills(skills);
    const turn: TurnVars = createTurnVars({ lastUserQuery: 'help me test things' });

    await handleCollect(env, turn, createChatData());

    expect(triologue.note).not.toHaveBeenCalledWith('HINT', expect.anything());
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
    expect(mockedExtractKeywords).toHaveBeenCalledTimes(1);
    expect(skillSuggester.getLastQuery()).toBe('help me refactor the parser');

    // The user clears the conversation (double-Ctrl+L / /clear): the
    // fresh-session primitive resets the suggester AND invalidates the
    // turn's composite sources.
    beginFreshSession(turn);

    // Next COLLECT: the triologue is empty and the turn sources are cleared,
    // so querySource is null → NO extraction. Resetting the suggester alone
    // would have left lastUserQuery populated → a spurious re-fire here.
    mockedExtractKeywords.mockClear();
    const result = await handleCollect(env, turn, createChatData());

    expect(mockedExtractKeywords).not.toHaveBeenCalled();
    expect(result).toBe(AgentState.LLM);
  });

});
