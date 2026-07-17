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
  startWrapUp: vi.fn(),
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
import { startWrapUp } from '../../../loop/esc-wrap-up.js';
import { loader } from '../../../context/shared/loader.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createPassData,
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

  it('should start wrap-up, clear neglected mode, and return PROMPT when ESC fires during hint gen', async () => {
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
    const pass = createPassData();

    const result = await handleCollect(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // startWrapUp called by the cleanup function
    expect(startWrapUp).toHaveBeenCalledTimes(1);
    expect(startWrapUp).toHaveBeenCalledWith(triologue, expect.any(Array));
    // neglected mode cleared before returning to PROMPT
    expect(agentIO.isNeglectedMode()).toBe(false);
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
    const pass = createPassData();

    await handleCollect(env, turn, pass);

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
    const pass = createPassData();

    const result = await handleCollect(env, turn, pass);

    expect(result).toBe(AgentState.LLM);
    // hint completed → confusion reset
    expect(resetFn).toHaveBeenCalledTimes(1);
    // no wrap-up on the normal path
    expect(startWrapUp).not.toHaveBeenCalled();
  });

  it('should skip hint block when confusion index is below threshold', async () => {
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));
    const ctx = createMockContext({
      core: { getConfusionIndex: vi.fn(() => 5) } as never, // < 10
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const turn = createTurnVars();
    const pass = createPassData();

    const result = await handleCollect(env, turn, pass);

    expect(result).toBe(AgentState.LLM);
    // hint block NOT entered → no wrap-up, no hint generation
    expect(startWrapUp).not.toHaveBeenCalled();
    expect(triologue.generateHintRound).not.toHaveBeenCalled();
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
    const pass = createPassData();

    await handleCollect(env, turn, pass);

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