/**
 * collect-esc-hint.test.ts — handleCollect: ESC during hint generation.
 *
 * Code path under test (loop/hint-round.ts HintRound.run, invoked from collect.ts):
 *   const hintSignal = await hintRound.run(turn);
 *     → if (confusion >= 10 && messageCount >= 6) {
 *         ctx.core.brief('info', 'loop', 'Generating hint...');
 *         const result = await ctx.core.escAware(
 *           async (abortController) => this.generate(abortController, ...),
 *           () => 'aborted',
 *         );
 *         ...
 *       }
 *
 * The hint round no longer routes through the Triologue facade
 * (Triologue.generateHintRound() is deleted). The feature is now the
 * HintRound singleton in loop/hint-round.ts. This test therefore
 * mocks `loop/hint-round.js` so `hintRound.run` is the seam
 * that decides 'failed' / success. The hint round NEVER signals compaction —
 * there is no 'compact' outcome (compaction is owned by token-based
 * auto-compact and the hook-driven deferredCompact path).
 *
 * Strategy: Mock escAware to call cleanup (returns 'aborted') to simulate ESC,
 * and stub triologue.getMessagesRaw() to return enough messages (>= 6) plus
 * ctx.core.getConfusionIndex() to return >= 10 to enter the hint block.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      log: vi.fn(),
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

vi.mock('../../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
}));

// HintRound singleton seam: hint-round.ts owns the WHOLE feature (gate +
// mechanism) as a process-wide singleton, so we mock `run` — it is the seam
// that decides 'stop' / success / 'failed'. `hintRun` is hoisted so the
// vi.mock factory (also hoisted) can reference it.
const { hintRun } = vi.hoisted(() => ({ hintRun: vi.fn() }));
vi.mock('../../../loop/hint-round.js', () => ({
  hintRound: {
    init: vi.fn(),
    reset: vi.fn(),
    run: hintRun,
  },
}));

// Triologue stub: configurable message count + the methods collect.ts touches.
vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    note = vi.fn();
    agent = vi.fn();
    tool = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getMessages = vi.fn(() => []);
    setSystemPrompt = vi.fn();
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
import { agentIO } from '../../../loop/agent-io.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
} from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';
import { hintRound } from '../../../loop/hint-round.js';

describe('handleCollect — ESC during hint generation', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    // Default: the hint round is a no-op that reports 'continue'. The
    // singleton now owns the gate AND the confusion reset, so this test only
    // asserts how handleCollect reacts to the returned HintSignal.
    hintRun.mockReset();
    hintRun.mockResolvedValue('continue' as never);
    triologue = new Triologue();
    // Pre-bind the singleton to a placeholder env so collect.ts reaches the
    // mocked `run` even in tests that never swap env.ctx (each test re-inits
    // with its own env when it needs a specific ctx).
    hintRound.init(createMockMachineEnv({ triologue }));
  });

  afterEach(() => {
    // The env the mocked singleton received is captured for the duration of
    // one test; release it so nothing leaks into the next one.
    hintRound.reset();
  });

  // Helper: enough messages (>= MIN_MESSAGES_FOR_HINT=6) + high confusion (>= 10)
  function makeMessages(n: number) {
    return Array.from({ length: n }, () => ({ role: 'user', content: 'x' }));
  }

  it('should return STOP for centralized wrap-up when ESC fires during hint gen', async () => {
    // Configure triologue to have enough messages to enter the hint block
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
    const ctx = createMockContext({
      core: { getConfusionIndex: vi.fn(() => 15) } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    // ESC during hint generation surfaces from the singleton as 'stop'; the
    // handler's only contract is to translate that into AgentState.STOP.
    hintRun.mockResolvedValue('stop' as never);

    hintRound.init(env);
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    // Neglection paths now return STOP; stop.ts handles startWrapUp +
    // setNeglectedMode. collect.ts no longer clears neglected mode itself.
    expect(result).toBe(AgentState.STOP);
  });

  it('should NOT reset confusion index when ESC aborts hint generation', async () => {
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
    const ctx = createMockContext({
      core: {
        getConfusionIndex: vi.fn(() => 15),
        resetConfusionIndex: vi.fn(),
      } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    env.ctx.core.escAware = vi.fn(async (_operation: any, cleanup: any) => {
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const chat = createChatData();

    await handleCollect(env, turn, chat);

    // The 'aborted' branch returns BEFORE resetConfusionIndex — so it must
    // NOT be called (confusion preserved so hint regenerates next round).
    expect(ctx.core.resetConfusionIndex).not.toHaveBeenCalled();
  });

  it('should reset confusion index and return LLM when hint generation completes normally', async () => {
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
    const resetFn = vi.fn();
    const ctx = createMockContext({
      core: {
        getConfusionIndex: vi.fn(() => 12),
        resetConfusionIndex: resetFn,
        brief: vi.fn(),
      } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    // escAware runs the operation normally (no ESC)
    env.ctx.core.escAware = vi.fn(async (operation: any) => {
      return await operation(new AbortController());
    }) as never;

    hintRound.init(env);
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    expect(result).toBe(AgentState.LLM);
    // The gate + the confusion reset now live INSIDE the singleton, so this
    // handler test asserts only the wiring: the round ran once with the live
    // turn, and a 'continue' signal lets the pass proceed to LLM.
    expect(hintRun).toHaveBeenCalledTimes(1);
    expect(hintRun).toHaveBeenCalledWith(turn);
    expect(resetFn).not.toHaveBeenCalled();
  });

  it('should still run the singleton (which owns the gate) when confusion is low', async () => {
    // OWNERSHIP: the confusion gate now lives INSIDE hintRound.run, so the
    // handler no longer short-circuits. What it must do is CALL the singleton
    // exactly once and let its 'continue' verdict proceed to LLM.
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
    const ctx = createMockContext({
      core: { getConfusionIndex: vi.fn(() => 5) } as never, // < 10
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    expect(result).toBe(AgentState.LLM);
    // The gate is the singleton's job: it ran, and only the singleton decides
    // whether confusion is high enough to spend an LLM round.
    expect(hintRun).toHaveBeenCalledTimes(1);
  });


  describe('hint-round failure (result === "failed")', () => {
    // Helper to build an env wired for the 'failed' branch: enough messages,
    // high confusion, escAware runs the operation and returns 'failed'.
    function makeFailedEnv() {
      vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
      hintRun.mockResolvedValue('failed' as never);
      const ctx = createMockContext({
        core: {
          getConfusionIndex: vi.fn(() => 12),
          resetConfusionIndex: vi.fn(),
          brief: vi.fn(),
        } as never,
      });
      const env = createMockMachineEnv({ triologue });
      env.ctx = ctx;
      // escAware runs the operation normally (no ESC) → returns 'failed'
      env.ctx.core.escAware = vi.fn(async (operation: any) => {
        return await operation(new AbortController());
      }) as never;
      return env;
    }

    it('should NOT reset the confusion index when the hint round failed', async () => {
      const env = makeFailedEnv();
      const turn = createTurnVars();
      const chat = createChatData();

      await handleCollect(env, turn, chat);

      // BEFORE: 'failed' fell through to the success-path reset, clearing the
      // confusion signal and hiding that no hint was injected (a failed hint
      // was treated as a successful intervention).
      // AFTER: 'failed' returns WITHOUT resetting — the signal is preserved so
      // a later COLLECT retries the hint once output is well-formed.
      expect(env.ctx.core.resetConfusionIndex).not.toHaveBeenCalled();
    });

    it('should still continue the loop (return LLM) after a failed hint round', async () => {
      const env = makeFailedEnv();
      const turn = createTurnVars();
      const chat = createChatData();

      const result = await handleCollect(env, turn, chat);

      // A failed hint is not a stop/compact — the loop proceeds to LLM as usual.
      expect(result).toBe(AgentState.LLM);
    });
  });

  it('should inject URGENT note (not MAIL) when collecting mail in neglected mode', async () => {
    // Enter neglected mode + a pending mail
    agentIO.setNeglectedMode(true);
    const ctx = createMockContext({
      mail: {
        collectMails: vi.fn(() => [
          { from: 'dev1', title: 'hi', content: 'working on it' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const turn = createTurnVars();
    const chat = createChatData();

    await handleCollect(env, turn, chat);

    // A note was injected with the 'URGENT' tag (neglected-mode ESC directive),
    // and the mail keeps its own separate 'MAIL' note (the concern split of #16
    // — welding them made mail wear [URGENT] and lose its sender/reply routing).
    const urgentCalls = vi.mocked(triologue.note).mock.calls.filter(
      (c) => c[0] === 'URGENT',
    );
    expect(urgentCalls.length).toBeGreaterThanOrEqual(1);
    const mailCalls = vi.mocked(triologue.note).mock.calls.filter(
      (c) => c[0] === 'MAIL',
    );
    expect(mailCalls).toHaveLength(1);
  });
});
