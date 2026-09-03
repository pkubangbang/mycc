/**
 * collect-transient-retry.test.ts — handleCollect: transient-error recovery
 * in auto mode + circuit breaker.
 *
 * Code path under test (collect.ts catch block):
 *   - A transient network error (e.g. "net/http: TLS handshake timeout" from
 *     the Ollama cloud endpoint during hint-round generation) is thrown inside
 *     the try block and reaches the catch.
 *   - In neglected mode → STOP (unchanged).
 *   - For a TRANSIENT error: call env.inputProvider.promptRetry. In auto mode
 *     promptRetry returns true → return COLLECT to retry the turn (self-
 *     recovery, no PROMPT→AWAIT stall). The per-turn counter
 *     turn.collectTransientRetries is incremented; when it reaches
 *     MAX_COLLECT_TRANSIENT_RETRIES the circuit breaker trips and the turn is
 *     abandoned to PROMPT (no more promptRetry calls).
 *   - For a NON-transient error → PROMPT directly (no promptRetry).
 *   - On a clean COLLECT pass (return LLM / compact), the counter resets to 0.
 *
 * Reproduction: the peer reported that a daemon stalled because a TLS
 * handshake timeout during hint-round generation aborted the in-flight turn
 * to PROMPT→AWAIT, which blocks forever for an external event in auto mode.
 * The fix mirrors the LLM state's transient-recovery (inputProvider.
 * promptRetry, which has an auto-mode guard returning true).
 *
 * Strategy: make ctx.team.handlePendingQuestions (the first step in the try
 * block) throw a transient error so the catch is reached without needing to
 * wire the hint-round threshold. Mock inputProvider.promptRetry to simulate
 * auto mode (returns true) or user decline (returns false).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      getAuto: vi.fn(() => false),
      log: vi.fn(),
      verbose: vi.fn(),
    },
  };
});

vi.mock('../../../loop/esc-wrap-up.js', () => ({
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>();
  return {
    ...actual,
    isVerbose: vi.fn(() => false),
  };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

vi.mock('../../../utils/skill-dedup.js', () => ({
  getSkillTriologueStatus: vi.fn(() => 'new'),
}));

vi.mock('../../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    note = vi.fn();
    agent = vi.fn();
    tool = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getMessages = vi.fn(() => []);
    setSystemPrompt = vi.fn();
    generateHintRound = vi.fn(async () => 'success' as const);
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
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
} from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';

// A transient error whose message contains 'timeout' → isTransientError true.
// Mirrors the peer's reported "net/http: TLS handshake timeout".
const TRANSIENT_ERROR = new Error(
  'Post "https://ollama.com:443/api/chat?ts=1788397616": net/http: TLS handshake timeout',
);
// A non-transient error (no pattern match) → isTransientError false.
const NON_TRANSIENT_ERROR = new Error('Cannot read properties of undefined (reading "role")');

describe('handleCollect — transient-error recovery + circuit breaker', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  /**
   * Build an env where ctx.team.handlePendingQuestions throws `err`, simulating
   * a failure early in the COLLECT try block (reaches the catch without wiring
   * the hint-round threshold). promptRetry is wired via inputProvider override.
   */
  function makeEnv(opts: {
    err: Error;
    promptRetry: () => Promise<boolean>;
    collectTransientRetries?: number;
  }) {
    const ctx = createMockContext({
      core: {
        getConfusionIndex: vi.fn(() => 0),
        brief: vi.fn(),
        verbose: vi.fn(),
      } as never,
      team: {
        handlePendingQuestions: vi.fn(async () => { throw opts.err; }),
        printTeam: vi.fn(() => 'No teammates.'),
        listTeammates: vi.fn(() => []),
      } as never,
    });
    const env = createMockMachineEnv({
      triologue,
      inputProvider: { promptRetry: vi.fn(opts.promptRetry) },
    });
    env.ctx = ctx;
    return env;
  }

  it('should return COLLECT (retry the turn) for a transient error when promptRetry says yes (auto mode)', async () => {
    const env = makeEnv({
      err: TRANSIENT_ERROR,
      // Auto mode: promptRetry always returns true (mirrors UserInputProvider
      // auto-mode guard `if (agentIO.getAuto()) return true;`).
      promptRetry: async () => true,
    });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    // BEFORE: returned PROMPT → in auto mode PROMPT→AWAIT blocks forever.
    // AFTER:  returns COLLECT → the turn is retried (self-recovery).
    expect(result).toBe(AgentState.COLLECT);
    expect(env.inputProvider.promptRetry).toHaveBeenCalledTimes(1);
    // Counter incremented so the circuit breaker can eventually trip.
    expect(turn.collectTransientRetries).toBe(1);
  });

  it('should return PROMPT for a transient error when promptRetry says no (user declined)', async () => {
    const env = makeEnv({
      err: TRANSIENT_ERROR,
      promptRetry: async () => false,
    });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    expect(env.inputProvider.promptRetry).toHaveBeenCalledTimes(1);
    // Counter NOT incremented when the retry is declined.
    expect(turn.collectTransientRetries).toBe(0);
  });

  it('should return PROMPT (no promptRetry) for a non-transient error', async () => {
    const env = makeEnv({
      err: NON_TRANSIENT_ERROR,
      promptRetry: async () => true, // would say yes, but must NOT be called
    });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    // Non-transient errors skip the recovery path entirely.
    expect(env.inputProvider.promptRetry).not.toHaveBeenCalled();
  });

  it('should trip the circuit breaker and return PROMPT after MAX retries (no promptRetry call)', async () => {
    // Pre-arm the counter at the cap so the breaker trips on this call.
    const env = makeEnv({
      err: TRANSIENT_ERROR,
      promptRetry: async () => true, // would retry, but breaker should prevent the call
    });
    const turn = createTurnVars({ collectTransientRetries: 3 });
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    // Circuit breaker tripped → abandon the turn to PROMPT, no further retry.
    expect(result).toBe(AgentState.PROMPT);
    // promptRetry must NOT be called once the cap is reached.
    expect(env.inputProvider.promptRetry).not.toHaveBeenCalled();
  });

  it('should still return STOP for a transient error in neglected mode (ESC takes priority)', async () => {
    const { agentIO } = await import('../../../loop/agent-io.js');
    agentIO.setNeglectedMode(true);

    const env = makeEnv({
      err: TRANSIENT_ERROR,
      promptRetry: async () => true, // would retry, but neglected mode short-circuits to STOP
    });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    // Neglected-mode guard runs BEFORE the transient recovery → STOP for
    // centralized wrap-up, no promptRetry call.
    expect(result).toBe(AgentState.STOP);
    expect(env.inputProvider.promptRetry).not.toHaveBeenCalled();
  });

  it('should reset collectTransientRetries to 0 on a clean COLLECT pass (return LLM)', async () => {
    // A clean pass: no throw, confusion below threshold (skips hint block).
    const ctx = createMockContext({
      core: {
        getConfusionIndex: vi.fn(() => 0),
        brief: vi.fn(),
        verbose: vi.fn(),
      } as never,
      team: {
        handlePendingQuestions: vi.fn(async () => {}),
        printTeam: vi.fn(() => 'No teammates.'),
        listTeammates: vi.fn(() => []),
      } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    // Pre-arm the counter as if a prior transient retry happened this turn.
    const turn = createTurnVars({ collectTransientRetries: 2 });
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    expect(result).toBe(AgentState.LLM);
    // Clean pass resets the circuit breaker for the next hiccup.
    expect(turn.collectTransientRetries).toBe(0);
  });
});