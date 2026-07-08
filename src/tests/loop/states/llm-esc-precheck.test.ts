/**
 * llm-esc-precheck.test.ts — handleLlm: isNeglectedMode() true BEFORE escAware.
 *
 * Code path under test (llm.ts:57-63):
 *   if (agentIO.isNeglectedMode()) {
 *     ctx.core.verbose('llm', 'ESC pressed before LLM call - starting wrap-up');
 *     stopSpinner();
 *     startWrapUp(triologue, tools);
 *     agentIO.setNeglectedMode(false);
 *     return AgentState.PROMPT;
 *   }
 *
 * Note: tools is computed at line 55 as
 *   `const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope)`
 * so when isNeglectedMode() is true, tools=[] — startWrapUp receives [].
 *
 * IMPORTANT: vi.mock() paths resolve relative to the TEST FILE location
 * (src/tests/loop/states/), so all paths need ../../../ (3 levels up to src/).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (must be set up BEFORE importing modules that use them) ----------
// All paths are relative to this test file: src/tests/loop/states/

// Mock the chat-provider (the actual module llm.ts imports retryChat/MODEL from)
vi.mock('../../../engine/chat-provider.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

// agentIO: isNeglectedMode() returns true (ESC already pressed)
vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => true),
    setNeglectedMode: vi.fn(),
  },
}));

// Mock esc-wrap-up so we can assert startWrapUp was called without firing LLM
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

// Minimal Triologue stub — we only need a reference object to pass around.
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
} from '../esc-test-helpers.js';

describe('handleLlm — ESC pre-check (isNeglectedMode before escAware)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  it('should call startWrapUp with triologue and (empty) tools, then return PROMPT', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData();

    const result = await handleLlm(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    expect(startWrapUp).toHaveBeenCalledTimes(1);
    // tools is [] because isNeglectedMode() is true at line 55
    expect(startWrapUp).toHaveBeenCalledWith(triologue, []);
  });

  it('should clear neglected mode after starting wrap-up', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData();

    await handleLlm(env, turn, pass);

    expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
  });

  it('should not call retryChat when already in neglected mode', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData();

    await handleLlm(env, turn, pass);

    expect(retryChat).not.toHaveBeenCalled();
  });

  it('should stop the spinner before returning to PROMPT', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData();

    await handleLlm(env, turn, pass);

    // stopSpinner is called at line 60 (before startWrapUp)
    expect(stopSpinner).toHaveBeenCalled();
    // setNeglectedMode(false) is called AFTER stopSpinner and startWrapUp
    expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
  });
});