/**
 * llm-esc-midcall.test.ts — handleLlm: ESC during retryChat (escAware cleanup returns null).
 *
 * Code path under test (llm.ts:65-96):
 *   const response = await ctx.core.escAware(
 *     async (abortController) => {
 *       pass.abortController = abortController;
 *       return await retryChat({ model, messages, tools, think }, { signal, neglected });
 *     },
 *     () => {
 *       startWrapUp(triologue, tools);  // ESC cleanup starts wrap-up
 *       return null;                      // cleanup returns null → response is null
 *     }
 *   );
 *   if (!response) {
 *     stopSpinner();
 *     agentIO.setNeglectedMode(false);
 *     return AgentState.PROMPT;
 *   }
 *
 * Strategy: Mock ctx.core.escAware to call cleanup instead of running the operation.
 * This simulates the ESC-wins-the-race path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../engine/chat-provider.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
    },
  };
});

vi.mock('../../../loop/esc-wrap-up.js', () => ({
  startWrapUp: vi.fn(),
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

vi.mock('../../../loop/crossroad.js', () => ({ handleCrossroad: vi.fn() }));
vi.mock('../../../engine/chat-helpers.js', () => ({ stopSpinner: vi.fn() }));

vi.mock('../../../loop/agent-prompts.js', () => ({
  buildPlanModePrompt: vi.fn(() => 'plan-prompt'),
  buildNormalModePrompt: vi.fn(() => 'normal-prompt'),
  isInPlanMode: vi.fn(() => false),
}));

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    setSystemPrompt = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getLastRole = vi.fn(() => null);
    agent = vi.fn();
    tool = vi.fn();
    getMessages = vi.fn(() => []);
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleLlm } from '../../../loop/states/llm.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { startWrapUp } from '../../../loop/esc-wrap-up.js';
import { stopSpinner } from '../../../engine/chat-helpers.js';
import { retryChat } from '../../../engine/chat-provider.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createPassData,
  createMockMachineEnv,
  createMockChatResponse,
} from '../esc-test-helpers.js';

describe('handleLlm — ESC during retryChat (escAware cleanup returns null)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  it('should return PROMPT and discard response when ESC fires during LLM call', async () => {
    const env = createMockMachineEnv({ triologue });
    // Mock escAware to simulate ESC: call cleanup (returns null) instead of operation
    env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    const result = await handleLlm(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // PassData should NOT be populated with LLM response
    expect(pass.rawToolCalls).toEqual([]);
    expect(pass.assistantContent).toBe('');
    expect(pass.abortController).toBeNull(); // released after ESC
  });

  it('should call startWrapUp during ESC cleanup', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    await handleLlm(env, turn, pass);

    // The cleanup function calls startWrapUp(triologue, tools)
    expect(startWrapUp).toHaveBeenCalledTimes(1);
    expect(startWrapUp).toHaveBeenCalledWith(triologue, expect.any(Array));
  });

  it('should clear neglected mode and stop spinner after ESC cleanup', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    await handleLlm(env, turn, pass);

    expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
    expect(stopSpinner).toHaveBeenCalled();
  });

  it('should pass think=false in retryChat request when not in neglected or plan mode', async () => {
    const env = createMockMachineEnv({ triologue });
    // This time escAware runs the operation normally (no ESC)
    env.ctx.core.escAware = vi.fn(async (operation) => {
      return await operation(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'hello' }) as never,
    );

    await handleLlm(env, turn, pass);

    // Verify retryChat was called with think: false (not neglected, not plan mode)
    expect(retryChat).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(retryChat).mock.calls[0][0] as { think: boolean };
    expect(callArgs.think).toBe(false);
  });

  it('should not execute crossroad block when tools array is empty', async () => {
    const env = createMockMachineEnv({ triologue });
    // Mock escAware to run the operation (no ESC), return a text-only response
    env.ctx.core.escAware = vi.fn(async (operation) => {
      return await operation(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'response' }) as never,
    );

    await handleLlm(env, turn, pass);

    // crossroad block is gated on tools.length > 0 — should not be entered
    // env.crossroadOccurred should be reset to false (else branch at line 150)
    expect(env.crossroadOccurred).toBe(false);
  });
});