/**
 * llm-esc-crossroad.test.ts — handleLlm: ESC during crossroad processing.
 *
 * Code path under test (llm.ts:118-150):
 *   if (tools.length > 0) {
 *     // Cooldown gate: if crossroadOccurred, skip detection, reset flag
 *     if (env.crossroadOccurred) {
 *       env.crossroadOccurred = false;
 *     } else {
 *       const crossroadResult = await ctx.core.escAware(
 *         async (abortController) => { return await handleCrossroad(...); },
 *         () => null,             // ESC cleanup returns null → transparent skip
 *       );
 *       if (agentIO.isNeglectedMode()) { stopSpinner(); return PROMPT; }
 *       if (crossroadResult) {
 *         ...apply crossroad...
 *         ctx.core.increaseConfusionIndex(2);  // unconditional +2 (every fire)
 *         env.crossroadOccurred = true;        // arm cooldown
 *       } else { env.crossroadOccurred = false; }
 *     }
 *   } else { env.crossroadOccurred = false; }
 *
 * Strategy:
 *  - To simulate ESC DURING crossroad: the 2nd escAware call (crossroad) calls
 *    cleanup (returns null). But isNeglectedMode() must ALSO be true for the
 *    early-return branch to fire. We make the first escAware (retryChat) run
 *    normally, then the second (crossroad) trigger the ESC path AND set
 *    neglected mode.
 *  - To test the "no crossroad" reset branch: handleCrossroad returns null.
 *  - To test the "crossroad applied" branch: handleCrossroad returns a
 *    CrossroadResult and neglected mode stays false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../engine/chat-provider.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

// agentIO: starts in normal mode; tests flip neglected as needed via the mock
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

// handleCrossroad is the unit under test's collaborator — mock it per-test
vi.mock('../../../loop/crossroad.js', () => ({
  handleCrossroad: vi.fn(),
}));

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
import { stopSpinner } from '../../../engine/chat-helpers.js';
import { handleCrossroad } from '../../../loop/crossroad.js';
import { retryChat } from '../../../engine/chat-provider.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createPassData,
  createMockMachineEnv,
  createMockChatResponse,
} from '../esc-test-helpers.js';

describe('handleLlm — ESC during crossroad processing', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the neglected-mode closure state (vi.clearAllMocks only clears
    // call history, not the captured `neglected` boolean).
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  it('should return PROMPT immediately when ESC fires during crossroad (neglected mode true)', async () => {
    const env = createMockMachineEnv({ triologue });
    // 1st escAware (retryChat): run normally
    // 2nd escAware (crossroad): call cleanup (returns null) AND set neglected=true
    let callCount = 0;
    env.ctx.core.escAware = vi.fn(async (operation: any, cleanup: any) => {
      callCount++;
      if (callCount === 1) {
        return await operation(new AbortController());
      }
      // crossroad escAware: simulate ESC → set neglected, call cleanup
      agentIO.setNeglectedMode(true);
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'some response' }) as never,
    );

    const result = await handleLlm(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // stopSpinner must be called on the ESC-during-crossroad path
    expect(stopSpinner).toHaveBeenCalled();
    // crossroadResult is null (from cleanup), so assistantContent is unchanged
    expect(pass.assistantContent).toBe('some response');
    // crossroadContinuation must NOT be set (crossroad was skipped)
    expect(pass.crossroadContinuation).toBeUndefined();
  });

  it('should apply crossroad result (truncate + continuation, discard tools) when crossroad succeeds', async () => {
    const env = createMockMachineEnv({ triologue });
    // Both escAware calls run the operation normally (no ESC)
    env.ctx.core.escAware = vi.fn(async (operation: any) => {
      return await operation(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({
        content: 'original text',
        toolCalls: [{ id: 'c1', function: { name: 'bash', arguments: {} } } as never],
      }) as never,
    );
    // handleCrossroad returns a valid result
    vi.mocked(handleCrossroad).mockResolvedValueOnce({
      truncated: 'original',
      continuation: 'Let me continue differently.',
    } as never);

    const result = await handleLlm(env, turn, pass);

    // No ESC → proceeds to HOOK
    expect(result).toBe(AgentState.HOOK);
    // assistantContent replaced with truncated prefix
    expect(pass.assistantContent).toBe('original');
    // continuation stored on pass
    expect(pass.crossroadContinuation).toBe('Let me continue differently.');
    // original tool calls discarded — LLM will regenerate them
    expect(pass.rawToolCalls).toEqual([]);
    // crossroadOccurred flag set
    expect(env.crossroadOccurred).toBe(true);
  });

  it('should reset crossroadOccurred flag when handleCrossroad returns null (no turning word)', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = vi.fn(async (operation: any) => {
      return await operation(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const pass = createPassData();
    // Flag starts false (normal case) — verify it stays false when no crossroad fires.
    // Note: pre-setting true would now trigger the cooldown gate (skip detection).
    env.crossroadOccurred = false;

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'plain response' }) as never,
    );
    // handleCrossroad returns null → no crossroad this pass
    vi.mocked(handleCrossroad).mockResolvedValueOnce(null as never);

    const result = await handleLlm(env, turn, pass);

    expect(result).toBe(AgentState.HOOK);
    // Flag must remain false because no crossroad occurred
    expect(env.crossroadOccurred).toBe(false);
    // content untouched, no continuation
    expect(pass.assistantContent).toBe('plain response');
    expect(pass.crossroadContinuation).toBeUndefined();
  });
});