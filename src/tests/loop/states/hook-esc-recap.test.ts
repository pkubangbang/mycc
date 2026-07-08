/**
 * hook-esc-recap.test.ts — handleHook: ESC during recap (recap cancellation).
 *
 * Code path under test (hook.ts handleRecapCall, lines ~196-210):
 *   const summary = await handleRecap(fullMessages, allTools, checkpoint.description,
 *                                     escAware, comment, lastUserQuery, checkpointResult);
 *   if (summary.startsWith('[RECAP] Cancelled:')) {
 *     triologue.agent(pass.assistantContent, pass.rawToolCalls, ...);
 *     triologue.tool('recap', summary, call.id);
 *     ctx.core.brief('warn', 'recap', summary);
 *     if (agentIO.isNeglectedMode()) {
 *       agentIO.setNeglectedMode(false);
 *       return AgentState.PROMPT;   // ← ESC-during-recap early return
 *     }
 *     turn.isFirstRound = false;
 *     return AgentState.COLLECT;
 *   }
 *
 * Strategy: Mock handleRecap to return '[RECAP] Cancelled: ...' and control
 * agentIO.isNeglectedMode(). Verify the PROMPT-vs-COLLECT branch selection.
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

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

vi.mock('../../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls: unknown[]) => calls),
}));

vi.mock('../../../loop/checkpoint-recap.js', () => ({
  validateCheckpointIsolation: vi.fn(() => ({ valid: true })),
  validateRecapIsolation: vi.fn(() => ({ valid: true })),
  handleCheckpoint: vi.fn(() => ({ result: 'ok' })),
  handleRecap: vi.fn(),
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    agent = vi.fn();
    tool = vi.fn();
    note = vi.fn();
    tool_name = undefined;
    getMessages = vi.fn(() => []);
    getMessagesRaw = vi.fn(() => []);
    getLastRole = vi.fn(() => null);
    setSystemPrompt = vi.fn();
    findCheckpointById = vi.fn(() => ({
      id: 'abc12345',
      index: 2,
      description: 'test checkpoint',
    }));
    findAllCheckpoints = vi.fn(() => []);
    recapMessages = vi.fn();
    getTokenCount = vi.fn(() => 100);
    skipPendingTools = vi.fn();
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleHook } from '../../../loop/states/hook.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { handleRecap } from '../../../loop/checkpoint-recap.js';
import { loader } from '../../../context/shared/loader.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createPassData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

describe('handleHook — ESC during recap (recap cancellation)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  /**
   * Build a pass + hookResult that routes through handleRecapCall.
   * The hookExecutor.processToolCalls returns a hookResult whose single call
   * is a 'recap' tool call (so the recap dispatch branch fires).
   */
  function makeRecapEnv() {
    const recapCall = createMockAugmentedToolCall('recap', {
      checkpoint_id: 'abc12345',
    });
    const env = createMockMachineEnv({ triologue });
    // processToolCalls returns a hookResult containing the recap call
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [recapCall] }),
    ) as never;
    return { env, recapCall };
  }

  it('should return PROMPT when ESC fires during recap (neglected mode true)', async () => {
    const { env, recapCall } = makeRecapEnv();
    const turn = createTurnVars();
    const pass = createPassData({ assistantContent: 'summarizing now' });

    // handleRecap returns the cancelled string (ESC during recap LLM call)
    vi.mocked(handleRecap).mockResolvedValueOnce(
      '[RECAP] Cancelled: ESC pressed during recap.' as never,
    );
    // ESC set neglected mode
    agentIO.setNeglectedMode(true);

    const result = await handleHook(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // Neglected mode cleared before returning to PROMPT
    expect(agentIO.isNeglectedMode()).toBe(false);
    // The cancelled summary registered as the recap tool result
    expect(triologue.tool).toHaveBeenCalledWith(
      'recap',
      '[RECAP] Cancelled: ESC pressed during recap.',
      recapCall.id,
    );
  });

  it('should return COLLECT (not PROMPT) when recap cancelled but neglected mode is false', async () => {
    const { env, recapCall } = makeRecapEnv();
    const turn = createTurnVars();
    const pass = createPassData({ assistantContent: 'summarizing now' });

    vi.mocked(handleRecap).mockResolvedValueOnce(
      '[RECAP] Cancelled: ESC pressed during recap.' as never,
    );
    // NOT in neglected mode — the cancelled-but-not-neglected path
    agentIO.setNeglectedMode(false);

    const result = await handleHook(env, turn, pass);

    expect(result).toBe(AgentState.COLLECT);
    // summary still registered as the recap tool result
    expect(triologue.tool).toHaveBeenCalledWith(
      'recap',
      '[RECAP] Cancelled: ESC pressed during recap.',
      recapCall.id,
    );
    // turn.isFirstRound flipped to false on the COLLECT branch
    expect(turn.isFirstRound).toBe(false);
  });

  it('should call handleRecap with full messages, tools, and escAware wrapper', async () => {
    const { env } = makeRecapEnv();
    const turn = createTurnVars({ lastUserQuery: 'finish the task' });
    const pass = createPassData({ assistantContent: 'let me recap' });

    // Normal (non-cancelled) recap completion
    vi.mocked(handleRecap).mockResolvedValueOnce('[RECAP] Summary text here.' as never);
    // Make getMessages return identifiable content so we can assert it was passed
    const fakeMessages = [{ role: 'user', content: 'msg1' }];
    vi.mocked(triologue.getMessages).mockReturnValue(fakeMessages as never);

    await handleHook(env, turn, pass);

    expect(handleRecap).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(handleRecap).mock.calls[0];
    // fullMessages (copy of getMessages), allTools, description, escAware fn, comment, lastUserQuery
    expect(callArgs[0]).toEqual(fakeMessages); // fullMessages
    expect(callArgs[1]).toEqual([{ function: { name: 'bash' } }]); // allTools from loader
    expect(callArgs[2]).toBe('test checkpoint'); // checkpoint.description
    expect(typeof callArgs[3]).toBe('function'); // escAware wrapper
    expect(callArgs[5]).toBe('finish the task'); // lastUserQuery
  });
});