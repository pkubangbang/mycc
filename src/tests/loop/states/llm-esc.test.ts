/**
 * llm-esc.test.ts — handleLlm: isNeglectedMode() true BEFORE escAware.
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
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

vi.mock('../../../loop/crossroad.js', () => ({ handleCrossroad: vi.fn() }));
vi.mock('../../../engine/chat-helpers.js', () => ({ stopSpinner: vi.fn() }));

vi.mock('../../../loop/prompts/lead.js', () => ({
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
    needsCompact = vi.fn(() => false);
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleLlm } from '../../../loop/states/llm.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { stopSpinner } from '../../../engine/chat-helpers.js';
import { retryChat } from '../../../engine/chat-provider.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockChatResponse,
} from '../esc-test-helpers.js';

describe('handleLlm — ESC pre-check (isNeglectedMode before escAware)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // ESC is already pressed when the LLM state is entered.
    vi.mocked(agentIO.isNeglectedMode).mockReturnValue(true);
    triologue = new Triologue();
  });

  it('should return STOP for centralized wrap-up (not PROMPT) when ESC already pressed', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleLlm(env, turn, chat);

    // Neglection paths now return STOP; stop.ts handles startWrapUp.
    expect(result).toBe(AgentState.STOP);
  });

  it('should not call retryChat when already in neglected mode', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    await handleLlm(env, turn, chat);

    expect(retryChat).not.toHaveBeenCalled();
  });

  it('should not clear neglected mode (stop.ts handles that)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    await handleLlm(env, turn, chat);

    // llm.ts no longer clears neglected mode — stop.ts does it.
    expect(agentIO.setNeglectedMode).not.toHaveBeenCalledWith(false);
  });

  it('should not stop the spinner (stop.ts handles that)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    await handleLlm(env, turn, chat);

    // llm.ts no longer calls stopSpinner on this path — stop.ts does.
    expect(stopSpinner).not.toHaveBeenCalled();
  });
});

describe('handleLlm — ESC during retryChat (escAware cleanup returns null)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // ESC has NOT been pressed yet: it fires inside retryChat (escAware cleanup).
    vi.mocked(agentIO.isNeglectedMode).mockReturnValue(false);
    triologue = new Triologue();
  });

  it('should return STOP and discard response when ESC fires during LLM call', async () => {
    const env = createMockMachineEnv({ triologue });
    // Mock escAware to simulate ESC: call cleanup (returns null) instead of operation
    env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleLlm(env, turn, chat);

    // Neglection paths now return STOP; stop.ts handles startWrapUp.
    expect(result).toBe(AgentState.STOP);
    // ChatData should NOT be populated with LLM response
    expect(chat.rawToolCalls).toEqual([]);
    expect(chat.assistantContent).toBe('');
    expect(chat.abortController).toBeNull(); // released after ESC
  });

  it('should not clear neglected mode or stop spinner (stop.ts handles those)', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = vi.fn(async (_operation, cleanup) => {
      return cleanup(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const chat = createChatData();

    await handleLlm(env, turn, chat);

    // llm.ts no longer clears neglected mode or stops the spinner on ESC —
    // stop.ts handles both. The cleanup just returns null.
    expect(agentIO.setNeglectedMode).not.toHaveBeenCalledWith(false);
    expect(stopSpinner).not.toHaveBeenCalled();
  });

  it('should pass think=false in retryChat request when not in neglected or plan mode', async () => {
    const env = createMockMachineEnv({ triologue });
    // This time escAware runs the operation normally (no ESC)
    env.ctx.core.escAware = vi.fn(async (operation) => {
      return await operation(new AbortController());
    }) as never;

    const turn = createTurnVars();
    const chat = createChatData();

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'hello' }) as never,
    );

    await handleLlm(env, turn, chat);

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
    const chat = createChatData();

    // Force an EMPTY tools array so the crossroad block (gated on
    // tools.length > 0) is genuinely skipped.
    const { loader } = await import('../../../context/shared/loader.js');
    vi.mocked(loader.getToolsForScope).mockReturnValue([]);

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'response' }) as never,
    );

    await handleLlm(env, turn, chat);

    // crossroad block is gated on tools.length > 0 — should not be entered
    // env.crossroadOccurred should be reset to false (else branch at line 150)
    expect(env.crossroadOccurred).toBe(false);
  });
});
