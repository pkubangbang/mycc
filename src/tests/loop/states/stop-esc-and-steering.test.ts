/**
 * stop-esc-and-steering.test.ts — handleStop: centralized neglection wrap-up.
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

// serve-registry: getServeHub stays mocked (stop.ts's normal-mode branch may
// reach it via ctx.team.awaitTeammates wiring), but the steering guarantees
// are asserted on the REAL manager singleton — the hub mocking is incidental.
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(),
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
import { getSteeringManager } from '../../../loop/steering-manager.js';
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




});

describe('handleStop — steering notes surface as review cards after ESC (not drained)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
    // The scenario where the bug manifested: notes queued while the agent was
    // working. Seeded in the REAL manager singleton (the hub no longer holds
    // a queue); wiped here so prior tests cannot leak notes in.
    getSteeringManager().clear();
    getSteeringManager().addNote('queued note A');
    getSteeringManager().addNote('queued note B');
  });

  it('does NOT drain steering on ESC mid-execution (notes stay for review card)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // ESC pressed mid-execution (hint round) — neglected mode active.
    agentIO.setNeglectedMode(true);
    // Last role is 'tool' (ESC during TOOL/hint — not 'assistant').
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    const drainSpy = vi.spyOn(getSteeringManager(), 'drainNotes');
    const result = await handleStop(env, turn, chat);
    drainSpy.mockRestore();

    // STOP returns PROMPT (the loop reaches the prompt for user input).
    expect(result).toBe(AgentState.PROMPT);
    // THE FIX: the queue was never drained. Notes stay in the manager so the
    // frontend's prompt handler can surface them as a review card.
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it('does NOT drain steering on ESC text-only path (notes stay for review card)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // ESC pressed — HOOK→STOP text-only path (lastRole is 'assistant').
    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');

    const drainSpy = vi.spyOn(getSteeringManager(), 'drainNotes');
    const result = await handleStop(env, turn, chat);
    drainSpy.mockRestore();

    expect(result).toBe(AgentState.PROMPT);
    // THE FIX: no drain on either neglection path.
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it('does NOT peek or drain the steering queue at STOP (queue untouched)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    // STOP should not even peek at the steering queue — the notes are left
    // entirely untouched for the frontend review card path. (isNonEmpty in
    // awaitTeammates is the AWAIT/STOP normal-mode seam and is NOT exercised
    // on the neglected path.)
    const drainSpy = vi.spyOn(getSteeringManager(), 'drainNotes');
    const peekTextsSpy = vi.spyOn(getSteeringManager(), 'peekTexts');
    const peekNotesSpy = vi.spyOn(getSteeringManager(), 'peekNotes');
    try {
      await handleStop(env, turn, chat);
      expect(drainSpy).not.toHaveBeenCalled();
      expect(peekTextsSpy).not.toHaveBeenCalled();
      expect(peekNotesSpy).not.toHaveBeenCalled();
    } finally {
      drainSpy.mockRestore();
      peekTextsSpy.mockRestore();
      peekNotesSpy.mockRestore();
    }
  });

  it('notes remain in the queue after ESC (no drain → queue intact)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    await handleStop(env, turn, chat);

    // The queue was never consumed — this is the structural guarantee that
    // notes remain available for the frontend prompt handler to move into
    // pendingSteeringReview when the 'prompt' broadcast arrives. The frontend
    // side is covered by message-dispatch.test.ts and the chaos-monkey harness.
    const notes = getSteeringManager().peekNotes();
    expect(notes.map((n) => n.text)).toEqual(['queued note A', 'queued note B']);
  });

  it('still turns off auto mode and starts wrap-up (fix does not break wrap-up)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    autoState.setAuto(true);
    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    await handleStop(env, turn, chat);

    // Auto mode turned off (ESC = "give me control back") — unchanged.
    expect(autoState.getAuto()).toBe(false);
    // Wrap-up still fires for the letter-box summary — unchanged.
    expect(startWrapUp).toHaveBeenCalledTimes(1);
  });
});
