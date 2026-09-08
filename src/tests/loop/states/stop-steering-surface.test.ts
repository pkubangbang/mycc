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
 *   4. AFTER the fix: stop.ts does NOT call drainSteering() → notes stay in
 *      both the backend queue and frontend buffer → when PROMPT is reached,
 *      the frontend's prompt handler moves steeringBuffer into
 *      pendingSteeringReview → review card surfaces.
 *
 * This test drives the REAL handleStop with a mocked serve hub and asserts:
 *   - handleStop returns PROMPT (not stuck in a loop)
 *   - drainSteering is NOT called (the fix)
 *   - getSteeringNotes is NOT called (no peek/drain at STOP)
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

// Mock the serve hub so we can assert drainSteering is NOT called and
// getSteeringNotes is NOT called. The serve-registry import is still needed
// because stop.ts's normal-mode branch (awaitTeammates) may reference it
// indirectly via ctx.team — but the neglection path no longer calls it.
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
import { getServeHub } from '../../../serve/serve-registry.js';
import { autoState } from '../../../loop/auto-state.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';

describe('handleStop — steering notes surface as review cards after ESC (not drained)', () => {
  let triologue: Triologue;
  let hub: {
    isRunning: ReturnType<typeof vi.fn>;
    getSteeringNotes: ReturnType<typeof vi.fn>;
    drainSteering: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
    // The serve hub is running with notes queued — the scenario where the
    // bug manifested. drainSteering is a spy so we can assert it's NOT called.
    hub = {
      isRunning: vi.fn(() => true),
      getSteeringNotes: vi.fn(() => ['queued note A', 'queued note B']),
      drainSteering: vi.fn(() => []),
    };
    vi.mocked(getServeHub).mockReturnValue(hub as never);
  });

  it('does NOT call drainSteering on ESC mid-execution (notes stay for review card)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // ESC pressed mid-execution (hint round) — neglected mode active.
    agentIO.setNeglectedMode(true);
    // Last role is 'tool' (ESC during TOOL/hint — not 'assistant').
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    const result = await handleStop(env, turn, chat);

    // STOP returns PROMPT (the loop reaches the prompt for user input).
    expect(result).toBe(AgentState.PROMPT);
    // THE FIX: drainSteering is NOT called. Notes stay in the backend queue
    // so the frontend's prompt handler can surface them as a review card.
    expect(hub.drainSteering).not.toHaveBeenCalled();
  });

  it('does NOT call drainSteering on ESC text-only path (notes stay for review card)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    // ESC pressed — HOOK→STOP text-only path (lastRole is 'assistant').
    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');

    const result = await handleStop(env, turn, chat);

    expect(result).toBe(AgentState.PROMPT);
    // THE FIX: drainSteering is NOT called on either neglection path.
    expect(hub.drainSteering).not.toHaveBeenCalled();
  });

  it('does NOT call getSteeringNotes at STOP (no peek/drain)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    await handleStop(env, turn, chat);

    // STOP should not even peek at the steering queue — the notes are left
    // entirely untouched for the frontend review card path.
    expect(hub.getSteeringNotes).not.toHaveBeenCalled();
  });

  it('notes remain in the queue after ESC (drainSteering not called → queue intact)', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const chat = createChatData();

    agentIO.setNeglectedMode(true);
    vi.mocked(triologue.getLastRole).mockReturnValue('tool');

    await handleStop(env, turn, chat);

    // The queue was never drained — drainSteering was not called (the fix).
    // This is the structural guarantee that notes remain available for the
    // frontend prompt handler to move into pendingSteeringReview when the
    // 'prompt' broadcast arrives. The frontend side is covered by
    // message-dispatch.test.ts and the chaos-monkey harness.
    expect(hub.drainSteering).not.toHaveBeenCalled();
    // getSteeringNotes was also not called (no peek at STOP).
    expect(hub.getSteeringNotes).not.toHaveBeenCalled();
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