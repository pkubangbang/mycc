/**
 * llm-empty-tool-role.test.ts — handleLlm: empty LLM output when lastRole === 'tool'.
 *
 * Regression test for a blocking bug:
 *   When the LLM returned empty content AND no tool calls right after a tool
 *   result (e.g. screen/img_describe returned a long image description, so the
 *   last triologue role was 'tool'), the empty-output handler had a guard
 *   `getLastRole() !== 'tool'` that SKIPPED the synthetic brief() injection.
 *   The loop then `continue`d and called retryChat with the IDENTICAL message
 *   array. Near the context boundary the LLM kept returning empty, producing a
 *   TIGHT INFINITE LOOP: process alive, spinner spinning, no output — only ESC
 *   (aborting retryChat via escAware → PROMPT) recovered it.
 *
 * Fix (llm.ts): the guard is removed — a synthetic brief() is ALWAYS injected
 * on empty output regardless of lastRole (attemptAutoFix safely bridges
 * tool → assistant for both providers). A per-handler `emptyRetries` counter
 * bails to PROMPT after MAX_EMPTY_RETRIES as a backstop so the agent never
 * spins forever.
 *
 * Code path under test (llm.ts empty-output handler):
 *   if (!chat.assistantContent && chat.rawToolCalls.length === 0) {
 *     emptyRetries++;
 *     if (emptyRetries > MAX_EMPTY_RETRIES) { stopSpinner(); return PROMPT; }
 *     triologue.agent('', [{ brief ... }]);
 *     triologue.tool('brief', 'OK', briefCallId);
 *     continue;
 *   }
 *
 * IMPORTANT: vi.mock() paths resolve relative to the TEST FILE location
 * (src/tests/loop/states/), so all paths need ../../../ (3 levels up to src/).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (must be set up BEFORE importing modules that use them) ----------

// Mock the chat-provider. retryChat is controlled per-test via mockResolvedValue.
vi.mock('../../../engine/chat-provider.js', () => ({
  retryChat: vi.fn(),
  MODEL: 'test-model',
}));

// agentIO: not in neglected mode (normal LLM call path).
vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => false),
    setNeglectedMode: vi.fn(),
  },
}));

vi.mock('../../../loop/esc-wrap-up.js', () => ({
  startWrapUp: vi.fn(),
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

// handleCrossroad returns null (no crossroad fires) so the empty-output path
// is reached with chat.assistantContent === '' and rawToolCalls === [].
vi.mock('../../../loop/crossroad.js', () => ({ handleCrossroad: vi.fn() }));
vi.mock('../../../engine/chat-helpers.js', () => ({ stopSpinner: vi.fn() }));

vi.mock('../../../loop/prompts/lead.js', () => ({
  buildPlanModePrompt: vi.fn(() => 'plan-prompt'),
  buildNormalModePrompt: vi.fn(() => 'normal-prompt'),
  isInPlanMode: vi.fn(() => false),
}));

// Provide a non-empty tools array so the crossroad branch is entered (and then
// skipped because handleCrossroad returns null). The empty-output handler runs
// AFTER the crossroad block regardless.
vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

// Triologue stub: getLastRole() is configurable per-test (defaults to 'tool',
// the post-img_describe case). agent()/tool() are spies so we can assert the
// synthetic brief injection happened.
vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    setSystemPrompt = vi.fn();
    getMessagesRaw = vi.fn(() => []);
    getLastRole = vi.fn(() => 'tool');
    agent = vi.fn();
    tool = vi.fn();
    getMessages = vi.fn(() => []);
    needsCompact = vi.fn(() => false);
  }
  return { Triologue: TriologueStub };
});

// autoState stub: recordLlmSuccess must exist (called on the success path).
vi.mock('../../../loop/auto-state.js', () => ({
  autoState: { recordLlmSuccess: vi.fn() },
}));

// --- Imports after mocks -----------------------------------------------------
import { handleLlm } from '../../../loop/states/llm.js';
import { AgentState } from '../../../loop/state-machine.js';
import { stopSpinner } from '../../../engine/chat-helpers.js';
import { retryChat } from '../../../engine/chat-provider.js';
import { Triologue } from '../../../loop/triologue.js';
import { autoState } from '../../../loop/auto-state.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockChatResponse,
} from '../esc-test-helpers.js';

/**
 * Build an empty-content, no-tool-calls ChatResponse — the exact shape that
 * triggered the bug.
 */
function emptyResponse() {
  return createMockChatResponse({ content: '', toolCalls: [] });
}

/**
 * Build a non-empty ChatResponse (has content) — used to assert the success
 * path is reached after recovery.
 */
function nonEmptyResponse() {
  return createMockChatResponse({ content: 'Here is my response.' });
}

describe('handleLlm — empty output when lastRole === "tool" (img_describe regression)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
    // Default: last role is 'tool' (post-screen/post-img_describe).
    (triologue.getLastRole as ReturnType<typeof vi.fn>).mockReturnValue('tool');
  });

  it('injects a synthetic brief() on empty output even when lastRole is "tool"', async () => {
    // First call empty → inject brief → continue. Second call non-empty → HOOK.
    vi.mocked(retryChat)
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(nonEmptyResponse());

    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleLlm(env, turn, chat);

    // Reached the success path.
    expect(result).toBe(AgentState.HOOK);
    // retryChat called twice: once empty, once after the injected brief.
    expect(retryChat).toHaveBeenCalledTimes(2);
    // THE REGRESSION: agent() and tool() MUST be called despite lastRole==='tool'.
    expect(triologue.agent).toHaveBeenCalledTimes(1);
    expect(triologue.tool).toHaveBeenCalledTimes(1);
    expect(triologue.tool).toHaveBeenCalledWith('brief', 'OK', expect.any(String));
  });

  it('does NOT infinite-loop: bails to PROMPT after MAX_EMPTY_RETRIES consecutive empties', async () => {
    // Always empty — simulates an LLM stuck returning empty near the context
    // boundary even after synthetic prompts. MAX_EMPTY_RETRIES is 3, so after
    // 3 injected briefs the 4th empty must bail to PROMPT instead of looping.
    vi.mocked(retryChat).mockResolvedValue(emptyResponse());

    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleLlm(env, turn, chat);

    // Backstop fired — control returned to the user, not an infinite spin.
    expect(result).toBe(AgentState.PROMPT);
    // Exactly MAX_EMPTY_RETRIES + 1 LLM calls (3 injected-brief retries, then
    // the 4th empty that triggers the bail-out).
    expect(retryChat).toHaveBeenCalledTimes(4);
    // 3 synthetic briefs injected (one per empty before the bail-out).
    expect(triologue.agent).toHaveBeenCalledTimes(3);
    expect(triologue.tool).toHaveBeenCalledTimes(3);
    // Spinner stopped before returning to PROMPT.
    expect(stopSpinner).toHaveBeenCalled();
  });

  it('still injects brief() when lastRole is NOT "tool" (non-regression of original path)', async () => {
    // Confirm the original (non-tool) path still injects exactly one brief.
    (triologue.getLastRole as ReturnType<typeof vi.fn>).mockReturnValue('assistant');
    vi.mocked(retryChat)
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(nonEmptyResponse());

    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleLlm(env, turn, chat);

    expect(result).toBe(AgentState.HOOK);
    expect(triologue.agent).toHaveBeenCalledTimes(1);
    expect(triologue.tool).toHaveBeenCalledWith('brief', 'OK', expect.any(String));
  });

  it('does not record an LLM success while spinning on empty output', async () => {
    // Only the final non-empty pass should record a success.
    vi.mocked(retryChat)
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(nonEmptyResponse());

    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    const result = await handleLlm(env, turn, chat);

    expect(result).toBe(AgentState.HOOK);
    // recordLlmSuccess is on the success exit path only — called exactly once.
    expect(autoState.recordLlmSuccess).toHaveBeenCalledTimes(1);
  });
});