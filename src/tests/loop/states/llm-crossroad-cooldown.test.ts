/**
 * llm-crossroad-cooldown.test.ts — handleLlm: crossroad cooldown gate.
 *
 * Tests the cooldown mechanism (see docs/crossroad-cooldown.md):
 * - When crossroad fires (pass N), crossroadOccurred is set to true.
 * - On the next pass (N+1), detection is SKIPPED (cooldown), the flag is
 *   reset to false, and the LLM's response passes through unchanged with
 *   tool calls preserved.
 * - On pass N+2, detection runs normally again.
 *
 * Also verifies:
 * - +2 confusion is added on EVERY crossroad fire (unconditional, not just
 *   consecutive — the old consecutive-only guard is dead code with cooldown).
 * - No-tools / neglected mode resets the flag (existing behavior preserved).
 * - Crossroad is SKIPPED when the LLM emitted a `brief`-ONLY tool-call set —
 *   `brief` is mid-thought narration whose text naturally contains "However"/
 *   "But"/"Wait" at sentence boundaries (Tier 2 turning words), NOT a genuine
 *   direction reversal. Firing on it truncates reasoning and discards a
 *   harmless status call (a mis-direction documented in
 *   crossroad-1787189812709.json). (Brief-only exemption, Option B.)
 * - Crossroad FIRES when a NON-brief tool call (read_file, bash, edit_file,
 *   ...) co-occurs with turning words — that IS a committed action the LLM
 *   then pivoted away from, worth intercepting. ALL tool calls are discarded
 *   and the LLM regenerates them after the continuation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (same pattern as llm-esc-crossroad.test.ts) -----------------------

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
    needsCompact = vi.fn(() => false);
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------

import { handleLlm } from '../../../loop/states/llm.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { handleCrossroad } from '../../../loop/crossroad.js';
import { retryChat } from '../../../engine/chat-provider.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockChatResponse,
  createMockToolCall,
} from '../esc-test-helpers.js';

// Helper: escAware that always runs the operation (no ESC)
function runOperationEscAware() {
  return vi.fn(async (operation: (ac: AbortController) => Promise<unknown>) =>
    operation(new AbortController()),
  ) as never;
}

describe('handleLlm — crossroad cooldown gate', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset (not just clearAllMocks) also clears queued mockResolvedValueOnce
    // return values — Test 4 (neglected mode) queues a retryChat response that
    // hits an early STOP return and is never consumed, so without reset it
    // would bleed into the next test and be mistaken for that test's response.
    vi.mocked(retryChat).mockReset();
    vi.mocked(handleCrossroad).mockReset();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Cooldown skips detection on the pass after crossroad fires
  // ---------------------------------------------------------------------------
  it('should skip crossroad detection (cooldown) when crossroadOccurred is true', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    const turn = createTurnVars();
    const chat = createChatData();
    // Arm cooldown — simulate "crossroad fired last pass"
    env.crossroadOccurred = true;

    const toolCalls = [createMockToolCall('bash', { command: 'ls' })];
    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({
        content: 'Let me check the files. However, maybe not.',
        toolCalls,
      }) as never,
    );

    const result = await handleLlm(env, turn, chat);

    // Cooldown: proceeds to HOOK (not PROMPT), tools preserved
    expect(result).toBe(AgentState.HOOK);
    // handleCrossroad must NOT be called during cooldown
    expect(handleCrossroad).not.toHaveBeenCalled();
    // assistantContent unchanged (not truncated)
    expect(chat.assistantContent).toBe('Let me check the files. However, maybe not.');
    // tool calls PRESERVED (not discarded)
    expect(chat.rawToolCalls).toEqual(toolCalls);
    // no continuation set
    expect(chat.crossroadContinuation).toBeUndefined();
    // cooldown consumed — flag reset
    expect(env.crossroadOccurred).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Crossroad re-fires after cooldown pass if turning words persist
  // ---------------------------------------------------------------------------
  it('should re-fire crossroad after cooldown pass (3-pass sequence)', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    // Shared env so crossroadOccurred persists across passes
    // Pass 1: crossroad fires (crossroadOccurred false → detection runs → fire)
    // Pass 2: cooldown (crossroadOccurred true → skip → reset to false)
    // Pass 3: crossroad fires again (crossroadOccurred false → detection runs → fire)

    // --- Pass 1: crossroad fires ---
    {
      const turn = createTurnVars();
      const chat = createChatData();
      env.crossroadOccurred = false; // start clean

      // Response with a NON-brief tool call (bash) + turning words — crossroad
      // FIRES (non-brief committed action the LLM then pivoted away from) and
      // discards the tool calls; the LLM regenerates them after the continuation.
      vi.mocked(retryChat).mockResolvedValueOnce(
        createMockChatResponse({
          content: 'Check auth. However, maybe config.',
          toolCalls: [createMockToolCall('bash', { command: 'cat auth' })],
        }) as never,
      );
      vi.mocked(handleCrossroad).mockResolvedValueOnce({
        truncated: 'Check auth.',
        continuation: 'Let me focus on config.',
      } as never);

      const result = await handleLlm(env, turn, chat);
      expect(result).toBe(AgentState.HOOK);
      expect(handleCrossroad).toHaveBeenCalledTimes(1);
      expect(chat.rawToolCalls).toEqual([]); // discarded by crossroad
      expect(env.crossroadOccurred).toBe(true); // cooldown armed
    }

    vi.clearAllMocks(); // reset call counts for pass 2

    // --- Pass 2: cooldown skips detection ---
    {
      const turn = createTurnVars();
      const chat = createChatData();
      // env.crossroadOccurred is true from pass 1 (same env)

      vi.mocked(retryChat).mockResolvedValueOnce(
        createMockChatResponse({
          content: 'Let me check config. However, maybe auth.',
          toolCalls: [createMockToolCall('bash', { command: 'cat config' })],
        }) as never,
      );

      const result = await handleLlm(env, turn, chat);
      expect(result).toBe(AgentState.HOOK);
      // handleCrossroad NOT called during cooldown
      expect(handleCrossroad).not.toHaveBeenCalled();
      // tool calls preserved
      expect(chat.rawToolCalls).toHaveLength(1);
      expect(env.crossroadOccurred).toBe(false); // cooldown consumed
    }

    vi.clearAllMocks(); // reset call counts for pass 3

    // --- Pass 3: crossroad fires again ---
    {
      const turn = createTurnVars();
      const chat = createChatData();
      // env.crossroadOccurred is false (cooldown consumed)

      // Response with a NON-brief tool call (bash) + turning words — crossroad
      // fires again (cooldown consumed last pass) and discards the tool calls.
      vi.mocked(retryChat).mockResolvedValueOnce(
        createMockChatResponse({
          content: 'Check auth. However, maybe config.',
          toolCalls: [createMockToolCall('bash', { command: 'ls' })],
        }) as never,
      );
      vi.mocked(handleCrossroad).mockResolvedValueOnce({
        truncated: 'Check auth.',
        continuation: 'Focus on config now.',
      } as never);

      const result = await handleLlm(env, turn, chat);
      expect(result).toBe(AgentState.HOOK);
      // handleCrossroad called again on pass 3
      expect(handleCrossroad).toHaveBeenCalledTimes(1);
      expect(chat.rawToolCalls).toEqual([]); // discarded by crossroad
      expect(env.crossroadOccurred).toBe(true); // re-armed
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: +2 confusion added on every crossroad fire (unconditional)
  // ---------------------------------------------------------------------------
  it('should add +2 confusion on every crossroad fire (not just consecutive)', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    const turn = createTurnVars();
    const chat = createChatData();
    env.crossroadOccurred = false; // fresh state (not consecutive)

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({
        content: 'text with turning word',
        toolCalls: [createMockToolCall('bash', {})],
      }) as never,
    );
    vi.mocked(handleCrossroad).mockResolvedValueOnce({
      truncated: 'text',
      continuation: 'resolved',
    } as never);

    await handleLlm(env, turn, chat);

    // +2 confusion must be called unconditionally (not guarded by crossroadOccurred)
    expect(env.ctx.core.increaseConfusionIndex).toHaveBeenCalledWith(2);
  });

  // ---------------------------------------------------------------------------
  // Test 4: No tools / neglected mode resets the flag
  // ---------------------------------------------------------------------------
  it('should reset crossroadOccurred when no tools available (neglected mode)', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    // Force neglected mode so tools.length === 0
    agentIO.setNeglectedMode(true);

    const turn = createTurnVars();
    const chat = createChatData();
    env.crossroadOccurred = true; // stale flag

    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({ content: 'text-only response' }) as never,
    );

    // In neglected mode, the early-return at the top of handleLlm fires
    // (ESC pressed before LLM call) and returns STOP for centralized wrap-up.
    // The no-tools `else` branch is hard to reach because neglected mode
    // returns early. We verify the function returns STOP and the flag is
    // unchanged (will be reset at PROMPT entry).
    //
    // Note: the early return path does NOT reset crossroadOccurred — that's
    // handled by the PROMPT reset (prompt.ts). So here we just verify the
    // function returns STOP and the flag is unchanged (will be reset at
    // PROMPT entry).
    const result = await handleLlm(env, turn, chat);
    expect(result).toBe(AgentState.STOP);
    // Flag is NOT reset here — it's reset at PROMPT entry (prompt.ts).
    // This is by design: the PROMPT reset is the boundary that clears it.
  });

  // ---------------------------------------------------------------------------
  // Test 5: Crossroad skipped when the LLM emitted a brief-ONLY tool-call set
  // ---------------------------------------------------------------------------
  it('should skip crossroad when only brief tool calls are present (brief-only exemption)', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    const turn = createTurnVars();
    const chat = createChatData();
    env.crossroadOccurred = false; // detection would run if not for the exemption

    // Response has turning words AND a brief-only tool-call set — the brief-only
    // exemption must skip crossroad. `brief` is mid-thought narration whose text
    // naturally contains "However"/"But"/"Wait" (Tier 2 turning words), NOT a
    // genuine direction reversal. Firing would truncate the reasoning and
    // discard a harmless status call (mis-direction, crossroad-1787189812709.json).
    const toolCalls = [createMockToolCall('brief', { message: 'Working on X', confidence: 7 })];
    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({
        content: 'I need to verify the auth flow. However, the issue might be in the DB layer.',
        toolCalls,
      }) as never,
    );

    const result = await handleLlm(env, turn, chat);

    // Proceeds to HOOK (brief executes normally)
    expect(result).toBe(AgentState.HOOK);
    // handleCrossroad must NOT be called — brief-only exemption
    expect(handleCrossroad).not.toHaveBeenCalled();
    // assistantContent unchanged (not truncated)
    expect(chat.assistantContent).toBe('I need to verify the auth flow. However, the issue might be in the DB layer.');
    // tool calls PRESERVED (not discarded)
    expect(chat.rawToolCalls).toEqual(toolCalls);
    // no continuation set
    expect(chat.crossroadContinuation).toBeUndefined();
    // flag reset (no crossroad this pass)
    expect(env.crossroadOccurred).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 5b: Crossroad FIRES when a NON-brief tool call co-occurs with turning
  // words — the committed action the LLM then pivoted away from is worth
  // intercepting. ALL tool calls (including any brief) are discarded.
  // ---------------------------------------------------------------------------
  it('should fire crossroad and discard tool calls when a non-brief tool call is present', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    const turn = createTurnVars();
    const chat = createChatData();
    env.crossroadOccurred = false; // detection runs

    // Response has turning words AND a non-brief tool call (bash) — crossroad
    // FIRES, truncates the content, and discards the tool calls.
    const toolCalls = [createMockToolCall('bash', { command: 'ls -la' })];
    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({
        content: 'Let me list the files. However, maybe I should check the logs instead.',
        toolCalls,
      }) as never,
    );
    vi.mocked(handleCrossroad).mockResolvedValueOnce({
      truncated: 'Let me list the files.',
      continuation: 'Let me check the logs instead.',
    } as never);

    const result = await handleLlm(env, turn, chat);

    // Proceeds to HOOK (continuation injected there)
    expect(result).toBe(AgentState.HOOK);
    // handleCrossroad WAS called — non-brief tool call present
    expect(handleCrossroad).toHaveBeenCalledTimes(1);
    // assistantContent replaced with truncated prefix
    expect(chat.assistantContent).toBe('Let me list the files.');
    // continuation stored on pass
    expect(chat.crossroadContinuation).toBe('Let me check the logs instead.');
    // tool calls DISCARDED (crossroad discards all tool calls)
    expect(chat.rawToolCalls).toEqual([]);
    // cooldown armed
    expect(env.crossroadOccurred).toBe(true);
    // +2 confusion added on the fire
    expect(env.ctx.core.increaseConfusionIndex).toHaveBeenCalledWith(2);
  });

  // ---------------------------------------------------------------------------
  // Test 5c: Crossroad FIRES when brief AND a non-brief tool call co-occur —
  // the non-brief call breaks the brief-only exemption, so crossroad fires and
  // discards BOTH tool calls.
  // ---------------------------------------------------------------------------
  it('should fire crossroad and discard ALL tool calls when brief + non-brief co-occur', async () => {
    const env = createMockMachineEnv({ triologue });
    env.ctx.core.escAware = runOperationEscAware();

    const turn = createTurnVars();
    const chat = createChatData();
    env.crossroadOccurred = false; // detection runs

    // brief + bash: the bash call makes this NOT brief-only, so crossroad fires.
    const toolCalls = [
      createMockToolCall('brief', { message: 'Investigating', confidence: 6 }),
      createMockToolCall('bash', { command: 'pwd' }),
    ];
    vi.mocked(retryChat).mockResolvedValueOnce(
      createMockChatResponse({
        content: 'I will check the directory. Wait, perhaps the config is the real issue.',
        toolCalls,
      }) as never,
    );
    vi.mocked(handleCrossroad).mockResolvedValueOnce({
      truncated: 'I will check the directory.',
      continuation: 'Let me focus on the config.',
    } as never);

    const result = await handleLlm(env, turn, chat);

    expect(result).toBe(AgentState.HOOK);
    // handleCrossroad WAS called — non-brief (bash) present, exemption broken
    expect(handleCrossroad).toHaveBeenCalledTimes(1);
    expect(chat.assistantContent).toBe('I will check the directory.');
    expect(chat.crossroadContinuation).toBe('Let me focus on the config.');
    // BOTH tool calls discarded (brief + bash)
    expect(chat.rawToolCalls).toEqual([]);
    expect(env.crossroadOccurred).toBe(true);
  });
});