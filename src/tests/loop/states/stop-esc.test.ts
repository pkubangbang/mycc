/**
 * stop-esc.test.ts — handleStop: centralized neglection wrap-up.
 *
 * Two neglection paths converge in STOP:
 *
 * 1. HOOK→STOP text-only path (existing): the LLM ran in neglected mode
 *    (empty tools) and produced a text-only response. Last triologue role
 *    is 'assistant'. The text IS the final response — display it via
 *    presentResult. No startWrapUp needed.
 *
 * 2. Direct ESC→STOP path (new): a state handler (LLM/TOOL/COLLECT/HOOK)
 *    detected neglection mid-execution and returned STOP. Last triologue
 *    role is NOT 'assistant' (the LLM didn't produce a usable response).
 *    startWrapUp fires a background wrap-up for a letter-box summary.
 *
 * Both paths turn off auto mode (ESC = "give me control back").
 *
 * The normal-mode (non-neglected) teammate-wait branch is covered by the
 * sibling stop-team-event-poll.test.ts (the awaitTeammates primitive that
 * replaced the one-shot awaitTeam call), which now delegates to awaitTeammates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

// agentIO: starts in neglected mode (ESC pressed); tests flip as needed.
vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      log: vi.fn(),
      flushOutput: vi.fn(),
    },
  };
});

vi.mock('../../../loop/state-machine.js', () => ({
  AgentState: {
    PROMPT: 'prompt',
    COLLECT: 'collect',
    LLM: 'llm',
    HOOK: 'hook',
    TOOL: 'tool',
    STOP: 'stop',
    AWAIT: 'await',
  },
  presentResult: vi.fn(),
}));

// esc-wrap-up: mock startWrapUp so we can assert it's called on the
// mid-execution ESC path without firing a background LLM call.
vi.mock('../../../loop/esc-wrap-up.js', () => ({
  startWrapUp: vi.fn(),
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

// loader: mock getToolsForScope (STOP calls it for the wrap-up tools list)
vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

// chat-helpers: mock stopSpinner (STOP calls it on the mid-execution ESC path)
vi.mock('../../../engine/chat-helpers.js', () => ({
  stopSpinner: vi.fn(),
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    tool = vi.fn();
    skipPendingTools = vi.fn();
    note = vi.fn();
    agent = vi.fn();
    getLastRole = vi.fn(() => null);
    getMessagesRaw = vi.fn(() => []);
    getMessages = vi.fn(() => []);
    setSystemPrompt = vi.fn();
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleStop } from '../../../loop/states/stop.js';
import { AgentState, presentResult } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { startWrapUp } from '../../../loop/esc-wrap-up.js';
import { stopSpinner } from '../../../engine/chat-helpers.js';
import { autoState } from '../../../loop/auto-state.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';

describe('handleStop — centralized neglection wrap-up', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  // ── Path 1: HOOK→STOP text-only (existing presentResult path) ──

  it('should display LLM text-only response via presentResult when lastRole is assistant', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // ESC pressed — neglected mode active at entry; LLM produced text-only response
    agentIO.setNeglectedMode(true);
    // Last triologue role is 'assistant' (HOOK→STOP text-only path)
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');

    const result = await handleStop(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    // Neglected mode cleared
    expect(agentIO.isNeglectedMode()).toBe(false);
    // presentResult called with triologue (the text-only response)
    expect(presentResult).toHaveBeenCalledWith(triologue);
    // startWrapUp NOT called (the text IS the wrap-up)
    expect(startWrapUp).not.toHaveBeenCalled();
  });

  it('should log "teammates still working" when a teammate has status working (text-only path)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'working' },
          { name: 'dev2', status: 'idle' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue, ctxOptions: { team: ctx.team } });
    env.ctx = ctx;
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');

    await handleStop(env, turn, chat);

    expect(agentIO.log).toHaveBeenCalledTimes(1);
    const logMsg = vi.mocked(agentIO.log).mock.calls[0][0] as string;
    expect(logMsg).toContain('teammates still working');
  });

  it('should NOT log teammates message when no teammate is working (text-only path)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'idle' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');

    await handleStop(env, turn, chat);

    expect(agentIO.log).not.toHaveBeenCalled();
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });

  // ── Path 2: Direct ESC→STOP (new startWrapUp path) ──

  it('should call startWrapUp and return PROMPT when ESC fired mid-execution (lastRole is NOT assistant)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // ESC pressed mid-execution — neglected mode active at entry
    agentIO.setNeglectedMode(true);
    // Last triologue role is 'tool' (e.g. ESC during TOOL state)
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    const result = await handleStop(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    // startWrapUp called (background wrap-up for letter-box summary)
    expect(startWrapUp).toHaveBeenCalledTimes(1);
    expect(startWrapUp).toHaveBeenCalledWith(triologue, expect.any(Array));
    // stopSpinner called before returning to PROMPT
    expect(stopSpinner).toHaveBeenCalled();
    // Neglected mode cleared
    expect(agentIO.isNeglectedMode()).toBe(false);
    // presentResult NOT called (no text-only response to display)
    expect(presentResult).not.toHaveBeenCalled();
  });

  it('should call startWrapUp when lastRole is null (ESC before any LLM call)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    // Last triologue role is null (no messages yet, or only user messages)
    vi.mocked(triologue.getLastRole).mockReturnValue(null);

    const result = await handleStop(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    // startWrapUp fires (null is not 'assistant' → mid-execution ESC path)
    expect(startWrapUp).toHaveBeenCalledTimes(1);
  });

  it('should call startWrapUp when lastRole is user (ESC during LLM call)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('user');

    const result = await handleStop(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    expect(startWrapUp).toHaveBeenCalledTimes(1);
    expect(presentResult).not.toHaveBeenCalled();
  });

  it('should turn off auto mode when ESC fires (mid-execution ESC path)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // Enable auto mode, then ESC
    autoState.setAuto(true);
    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    await handleStop(env, turn, chat);

    // Auto mode turned off (ESC = "give me control back")
    expect(autoState.getAuto()).toBe(false);
  });

  it('should turn off auto mode when ESC fires (text-only path)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    autoState.setAuto(true);
    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');

    await handleStop(env, turn, chat);

    expect(autoState.getAuto()).toBe(false);
  });
});