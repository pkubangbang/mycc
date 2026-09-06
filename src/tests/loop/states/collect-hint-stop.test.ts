/**
 * collect-hint-stop.test.ts — handleCollect + real escAware + real triggerNeglection.
 *
 * Reproduces the WebUI 停止 (stop) button during the hint round in auto mode:
 *   WS 'interrupt' → agentIO.triggerNeglection() → escAware's onNeglectedHandler
 *   → abortController.abort() + onCleanUp() → escResolver('aborted')
 *   → handleCollect returns STOP → STOP → PROMPT (auto off).
 *
 * Unlike collect-esc-hint.test.ts (which mocks escAware to call cleanup
 * directly), this test uses the REAL Core.escAware and the REAL
 * agentIO.triggerNeglection() — the exact code path the 停止 button drives.
 * It asserts the escAware promise resolves (no hang) and handleCollect
 * returns STOP so the loop can proceed to PROMPT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

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

// Triologue stub: configurable message count + hint generation that blocks
// until aborted (simulating a slow hint-round LLM call).
vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    note = vi.fn();
    agent = vi.fn();
    tool = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getMessages = vi.fn(() => []);
    setSystemPrompt = vi.fn();
    generateHintRound = vi.fn(async (abortController: AbortController) => {
      // Simulate a slow hint-round LLM call that only returns when aborted.
      await new Promise((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(undefined));
      });
      return 'aborted' as const;
    });
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
import { Core } from '../../../context/parent/core.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
} from '../esc-test-helpers.js';

describe('handleCollect — real escAware + real triggerNeglection (WebUI 停止 during hint round)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    // Clear any registered neglected callbacks so they don't leak across tests.
    (agentIO as unknown as { onNeglectedCallbacks: Set<() => void> }).onNeglectedCallbacks = new Set();
    triologue = new Triologue();
  });

  function makeMessages(n: number) {
    return Array.from({ length: n }, () => ({ role: 'user', content: 'x' }));
  }

  it('should return STOP (not hang) when 停止 fires during hint generation', async () => {
    // Configure triologue to enter the hint block (>= 6 messages, >= 10 confusion).
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));

    // Use a REAL Core so escAware is the real implementation (registers
    // onNeglectedHandler, races operation vs escPromise).
    const core = new Core('/tmp');
    core.getConfusionIndex = vi.fn(() => 15) as never;

    const env = createMockMachineEnv({ triologue });
    env.ctx.core = core as never;

    const turn = createTurnVars();
    const chat = createChatData();

    // Start handleCollect — it enters the hint round and blocks in escAware.
    const collectPromise = handleCollect(env, turn, chat);

    // Give escAware a tick to register its onNeglectedHandler and start the
    // hint-round operation.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Simulate the WebUI 停止 button: WS 'interrupt' → triggerNeglection().
    agentIO.triggerNeglection();

    // handleCollect MUST resolve with STOP (not hang). Race against a timeout.
    const result = await Promise.race([
      collectPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(result).toBe(AgentState.STOP);
    // Neglected mode is set (STOP state will clear it).
    expect(agentIO.isNeglectedMode()).toBe(true);
  });

  it('should NOT reset confusion index when 停止 aborts hint generation', async () => {
    vi.mocked(triologue.getMessagesRaw).mockReturnValue(makeMessages(8));

    const core = new Core('/tmp');
    const resetFn = vi.fn();
    core.getConfusionIndex = vi.fn(() => 15) as never;
    core.resetConfusionIndex = resetFn as never;

    const env = createMockMachineEnv({ triologue });
    env.ctx.core = core as never;

    const turn = createTurnVars();
    const chat = createChatData();

    const collectPromise = handleCollect(env, turn, chat);
    await new Promise((resolve) => setTimeout(resolve, 20));
    agentIO.triggerNeglection();

    const result = await Promise.race([
      collectPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(result).toBe(AgentState.STOP);
    // The 'aborted' branch returns BEFORE resetConfusionIndex — so it must
    // NOT be called (confusion preserved so hint regenerates next round).
    expect(resetFn).not.toHaveBeenCalled();
  });
});
