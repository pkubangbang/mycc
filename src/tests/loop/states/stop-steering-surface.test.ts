/**
 * stop-steering-surface.test.ts — Regression: steering notes surface as review
 * cards after ESC, instead of being silently drained and lost.
 *
 * Reproduces the clear-before-review race:
 *   1. User queues steering notes during a hint round (steer-echo populates
 *      both backend queue and frontend buffer).
 *   2. ESC fires during the hint round → collect.ts returns STOP.
 *   3. BEFORE the fix: stop.ts called drainSteering() → broadcast steer-flush
 *      → frontend cleared steeringBuffer BEFORE the subsequent 'prompt'
 *      broadcast could read it → no review card → notes lost.
 *   4. AFTER the fix: stop.ts does NOT drain/peek the steering queue → notes
 *      stay in the manager + frontend buffer → when PROMPT is reached, the
 *      frontend's prompt handler moves steeringBuffer into
 *      pendingSteeringReview → review card surfaces.
 *
 * The old assertions spied on the hub's drainSteering/getSteeringNotes
 * facades; those facades were DELETED (loop consumers read the loop-homed
 * manager directly — plan §6/Δ3, hub keeps pushSteer/resolveSteering only),
 * so the same guarantees are now pinned against the REAL manager singleton:
 * spy drainNotes/peek* to prove STOP never touches the queue, and assert the
 * notes are still queued afterwards.
 *
 * This test drives the REAL handleStop with the real steering manager and
 * asserts:
 *   - handleStop returns PROMPT (not stuck in a loop)
 *   - manager.drainNotes() is NOT called (the fix)
 *   - manager peek/drain are NOT called (no peek/drain at STOP)
 *   - The notes remain in the queue for the frontend review card path
 *
 * The frontend side (buffer → pendingSteeringReview at prompt) is covered by
 * the chaos-monkey harness and message-dispatch.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

// agentIO: starts in neglected mode (ESC pressed).
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

vi.mock('../../../loop/esc-wrap-up.js', () => ({
  startWrapUp: vi.fn(),
  evaluateWrapUp: vi.fn(),
  clearWrapUp: vi.fn(),
}));

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

vi.mock('../../../engine/chat-helpers.js', () => ({
  stopSpinner: vi.fn(),
}));

// serve-registry: getServeHub stays mocked (stop.ts's normal-mode branch may
// reach it via ctx.team.awaitTeammates wiring), but the steering guarantees
// here are asserted on the REAL manager — the hub mocking is incidental.
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
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { startWrapUp } from '../../../loop/esc-wrap-up.js';
import { getSteeringManager } from '../../../loop/steering-manager.js';
import { autoState } from '../../../loop/auto-state.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';

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