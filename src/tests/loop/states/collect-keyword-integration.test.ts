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
 * skill-dedup, worktree-store, triologue, AND keyword-extractor (so the real
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
    // runKeywordExtraction now passes loader.getSkillKeywords() into
    // extractKeywords; stub it so the COLLECT step 6 path resolves.
    getSkillKeywords: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/skill-dedup.js', () => ({
  getSkillTriologueStatus: vi.fn(() => 'new'),
}));

vi.mock('../../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
}));

// keyword-extractor: the mock controls the extraction outcome so we can test
// each union variant without an LLM call. The mock factory captures the
// configured return value via a module-level let, reassigned per-test through
// the imported `setExtractionResult` helper below.
let extractionResult: KeywordExtractionResult = { status: 'success', keywords: [] };
vi.mock('../../../loop/keyword-extractor.js', () => ({
  extractKeywords: vi.fn(async (): Promise<KeywordExtractionResult> => extractionResult),
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
import { extractKeywords } from '../../../loop/keyword-extractor.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
} from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';
import type { TurnVars } from '../../../loop/state-machine.js';

/** Configure the mocked extractKeywords to return the given result. */
function setExtractionResult(result: KeywordExtractionResult): void {
  extractionResult = result;
}

describe('handleCollect — composite keyword extraction (integration)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level mock state to safe defaults.
    extractionResult = { status: 'success', keywords: [] };
    serveRunning = false;
    steeredNotes = [];
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

  // ---------------------------------------------------------------------------
  // success path
  // ---------------------------------------------------------------------------

  it('SUCCESS: arms lastSkillY + cooldown=3 and consumes extractKeywords once', async () => {
    setExtractionResult({ status: 'success', keywords: ['parser', 'test'] });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    expect(turn.lastSkillY).toBe('help me test the parser');
    expect(turn.skillDiscoveryCooldown).toBe(3);
    expect(vi.mocked(extractKeywords)).toHaveBeenCalledTimes(1);
  });

  it('SUCCESS with empty keywords still arms the cooldown (op completed)', async () => {
    setExtractionResult({ status: 'success', keywords: [] });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'some query with no skill match',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    expect(turn.lastSkillY).toBe('some query with no skill match');
    expect(turn.skillDiscoveryCooldown).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // skipped path (trivial query)
  // ---------------------------------------------------------------------------

  it('SKIPPED: marks Y as seen + cooldown=3 (trivial query does not loop)', async () => {
    setExtractionResult({ status: 'skipped' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'hello',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    expect(turn.lastSkillY).toBe('hello');
    expect(turn.skillDiscoveryCooldown).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // failed path (ESC / transient) — the P1 fix
  // ---------------------------------------------------------------------------

  it('FAILED: does NOT arm lastSkillY or cooldown (Y stays eligible for retry)', async () => {
    setExtractionResult({ status: 'failed' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    // Neither field is touched — the discovery opportunity is preserved.
    expect(turn.lastSkillY).toBe('');
    expect(turn.skillDiscoveryCooldown).toBe(0);
  });

  it('FAILED: a second pass with the same Y re-triggers extraction (retry works)', async () => {
    setExtractionResult({ status: 'failed' });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    // Pass 1: fails, leaves Y eligible.
    await handleCollect(env, turn, createChatData());
    expect(vi.mocked(extractKeywords)).toHaveBeenCalledTimes(1);
    expect(turn.lastSkillY).toBe('');
    expect(turn.skillDiscoveryCooldown).toBe(0);

    // Pass 2: same Y, no cooldown, lastSkillY still '' → extraction fires again.
    vi.mocked(extractKeywords).mockClear();
    await handleCollect(env, turn, createChatData());
    expect(vi.mocked(extractKeywords)).toHaveBeenCalledTimes(1);
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
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    expect(turn.lastSkillY).toBe('');
    expect(turn.skillDiscoveryCooldown).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // gating: no extraction when Y unchanged or cooldown active
  // ---------------------------------------------------------------------------

  it('does NOT call extractKeywords when Y is unchanged (lastSkillY === Y)', async () => {
    setExtractionResult({ status: 'success', keywords: [] });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'same query',
      lastSkillY: 'same query', // already seen
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    expect(vi.mocked(extractKeywords)).not.toHaveBeenCalled();
  });

  it('does NOT call extractKeywords when cooldown > 0', async () => {
    setExtractionResult({ status: 'success', keywords: [] });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'a new query',
      lastSkillY: 'old query', // Y changed
      skillDiscoveryCooldown: 2, // but cooldown active
    });

    await handleCollect(env, turn, createChatData());

    expect(vi.mocked(extractKeywords)).not.toHaveBeenCalled();
    // Cooldown was decremented once at the top of step 6.
    expect(turn.skillDiscoveryCooldown).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // steering-note path (BUG 1 — no spurious double-trigger)
  // ---------------------------------------------------------------------------

  it('STEERING NOTE: triggers on the note, marks the fallback lastUserQuery as seen', async () => {
    setExtractionResult({ status: 'success', keywords: ['tests'] });
    serveRunning = true;
    steeredNotes = ['focus on tests'];
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'original user query',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    await handleCollect(env, turn, createChatData());

    // BUG 1 fix: lastSkillY is the FALLBACK (lastUserQuery), not the steering
    // note, so the consumed-note → fallback re-trigger does not fire.
    expect(turn.lastSkillY).toBe('original user query');
    expect(turn.skillDiscoveryCooldown).toBe(3);
  });

  it('STEERING NOTE consumed: a second pass with no note does NOT re-trigger', async () => {
    setExtractionResult({ status: 'success', keywords: ['tests'] });
    serveRunning = true;
    steeredNotes = ['focus on tests'];
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'original user query',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    // Pass 1: steering note triggers, applies BUG 1 fix.
    await handleCollect(env, turn, createChatData());
    expect(turn.lastSkillY).toBe('original user query');
    expect(turn.skillDiscoveryCooldown).toBe(3);

    // Drain cooldown over passes 2, 3, 4 (no steering notes queued).
    steeredNotes = [];
    vi.mocked(extractKeywords).mockClear();
    for (let i = 0; i < 3; i++) {
      await handleCollect(env, turn, createChatData());
    }
    expect(turn.skillDiscoveryCooldown).toBe(0);

    // Pass 5: steering note is consumed (serveRunning but no notes). Y falls
    // back to lastUserQuery, which equals lastSkillY → NO re-trigger.
    vi.mocked(extractKeywords).mockClear();
    const result = await handleCollect(env, turn, createChatData());
    expect(vi.mocked(extractKeywords)).not.toHaveBeenCalled();
    expect(result).toBe(AgentState.LLM);
  });

  // ---------------------------------------------------------------------------
  // sanity: handleCollect still returns LLM on the extraction path
  // ---------------------------------------------------------------------------

  it('returns LLM after a successful extraction pass', async () => {
    setExtractionResult({ status: 'success', keywords: ['x'] });
    const env = makeEnv();
    const turn: TurnVars = createTurnVars({
      lastUserQuery: 'help me test the parser',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });

    const result = await handleCollect(env, turn, createChatData());
    expect(result).toBe(AgentState.LLM);
  });
});