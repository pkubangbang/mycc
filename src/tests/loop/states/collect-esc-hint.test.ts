/**
 * collect-esc-hint.test.ts — handleCollect: ESC during hint generation.
 *
 * Code path under test (collect.ts:113-135):
 *   if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
 *     ctx.core.brief('info', 'loop', 'Generating hint...');
 *     const pendingSkills = env.conditions.getPending();
 *     const breakdown = generateBreakdown(confusionIndex, env.sequence.getEvents());
 *     const result = await ctx.core.escAware(
 *       async (abortController) => {
 *         return await triologue.generateHintRound(abortController, ...);
 *       },
 *       () => {
 *         startWrapUp(triologue, loader.getToolsForScope(env.scope));
 *         return 'aborted' as const;
 *       }
 *     );
 *     if (result === 'aborted') {
 *       agentIO.setNeglectedMode(false);
 *       return AgentState.PROMPT;
 *     }
 *     ctx.core.resetConfusionIndex();
 *   }
 *
 * Also tests the neglected-mode mail-injection branch (URGENT vs MAIL note).
 *
 * Strategy: Mock escAware to call cleanup (returns 'aborted') to simulate ESC,
 * and stub triologue.getMessagesRaw() to return enough messages (>= 6) plus
 * ctx.core.getConfusionIndex() to return >= 10 to enter the hint block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../../utils/skill-dedup.js', () => ({
  getSkillTriologueStatus: vi.fn(() => 'new'),
}));

vi.mock('../../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(async () => []),
}));

// Triologue stub: configurable message count + hint generation
vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    note = vi.fn();
    agent = vi.fn();
    tool = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getMessages = vi.fn(() => []);
    setSystemPrompt = vi.fn();
    generateHintRound = vi.fn(async () => 'hint round text');
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

describe('handleCollect — ESC during hint generation', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
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
    // escAware cleanup returns 'aborted' (ESC during hint generation)
    env.ctx.core.escAware = vi.fn(async (_operation: any, cleanup: any) => {
      return cleanup(new AbortController());
    }) as never;

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

    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleCollect(env, turn, chat);

    expect(result).toBe(AgentState.LLM);
    // hint completed → confusion reset
    expect(resetFn).toHaveBeenCalledTimes(1);
  });

  it('should skip hint block when confusion index is below threshold', async () => {
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
    // hint block NOT entered → no hint generation
    expect(triologue.generateHintRound).not.toHaveBeenCalled();
  });

  describe('hint-round compaction (result === "compact")', () => {
    // Helper to build an env wired for the 'compact' branch: enough messages,
    // high confusion, escAware runs the operation and returns 'compact'.
    function makeCompactEnv() {
      vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
      vi.mocked(triologue.generateHintRound).mockResolvedValue('compact' as never);
      const ctx = createMockContext({
        core: {
          getConfusionIndex: vi.fn(() => 12),
          resetConfusionIndex: vi.fn(),
          brief: vi.fn(),
        } as never,
      });
      const env = createMockMachineEnv({ triologue });
      env.ctx = ctx;
      // escAware runs the operation normally (no ESC) → returns 'compact'
      env.ctx.core.escAware = vi.fn(async (operation: any) => {
        return await operation(new AbortController());
      }) as never;
      return env;
    }

    it('should return COLLECT (not STOP) so the loop continues on compacted context', async () => {
      const env = makeCompactEnv();
      const turn = createTurnVars();
      const chat = createChatData();

      const result = await handleCollect(env, turn, chat);

      // BEFORE: return STOP → PROMPT (loop stalled at PROMPT, waiting for user).
      // AFTER:  return COLLECT → LLM retries on the compacted triologue, same turn.
      expect(result).toBe(AgentState.COLLECT);
      expect(result).not.toBe(AgentState.STOP);
    });

    it('should call triologue.compact to perform the compaction', async () => {
      const env = makeCompactEnv();
      const turn = createTurnVars();
      const chat = createChatData();

      await handleCollect(env, turn, chat);

      expect(triologue.compact).toHaveBeenCalledTimes(1);
    });

    it('should reset confusion index after hint-compact', async () => {
      const env = makeCompactEnv();
      const turn = createTurnVars();
      const chat = createChatData();

      await handleCollect(env, turn, chat);

      expect(env.ctx.core.resetConfusionIndex).toHaveBeenCalledTimes(1);
    });

    it('should reset sequence, hookExecutor, and requestEmbeddingTracker (mirror llm.ts auto-compact)', async () => {
      const env = makeCompactEnv();
      const turn = createTurnVars();
      const chat = createChatData();

      await handleCollect(env, turn, chat);

      // Stat counts were computed against the pre-compact history; after
      // compact() they are stale and must be cleared, exactly as the llm.ts
      // auto-compact branch does. Without these the continued loop runs on
      // corrupted stats (e.g. sequence events inflating the next confusion
      // score, hook dedup cap suppressing the next turn's hooks).
      expect(env.sequence.clear).toHaveBeenCalledTimes(1);
      expect(env.hookExecutor.resetTurn).toHaveBeenCalledTimes(1);
      expect(env.requestEmbeddingTracker.clear).toHaveBeenCalledTimes(1);
    });

    it('should reset crossroadOccurred to false', async () => {
      const env = makeCompactEnv();
      env.crossroadOccurred = true; // arm a stale cooldown
      const turn = createTurnVars();
      const chat = createChatData();

      await handleCollect(env, turn, chat);

      expect(env.crossroadOccurred).toBe(false);
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

    // A note was injected with the 'URGENT' tag (neglected-mode mail handling)
    const urgentCalls = vi.mocked(triologue.note).mock.calls.filter(
      (c) => c[0] === 'URGENT',
    );
    expect(urgentCalls.length).toBeGreaterThanOrEqual(1);
    const mailCalls = vi.mocked(triologue.note).mock.calls.filter(
      (c) => c[0] === 'MAIL',
    );
    expect(mailCalls).toHaveLength(0);
  });
});