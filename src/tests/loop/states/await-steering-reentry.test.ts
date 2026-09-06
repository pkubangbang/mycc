/**
 * await-steering-reentry.test.ts — AWAIT re-entry on a lingering steering note.
 *
 * Reproduces the tight-loop hang after the WebUI 停止 (stop) button aborts a
 * hint round in auto mode:
 *
 *   1. Loop in AWAIT (auto mode). A steering note arrives → awaitTeammates
 *      returns 'steering' → COLLECT.
 *   2. COLLECT step 2c drains the FIRST note, then runs the hint round.
 *   3. A SECOND steering note arrives DURING the hint round (after 2c drained
 *      the first) → it stays in the queue (drain is a single consumption point).
 *   4. User clicks 停止 → handleCollect returns STOP → STOP turns auto off →
 *      PROMPT. The second note is NOT drained (PROMPT synthesis only runs on a
 *      fresh user query, which is null here).
 *   5. If auto re-engages (autofly / channel / user), the loop re-enters AWAIT,
 *      which immediately re-wakes on the lingering note → COLLECT → hint round
 *      → ... a tight loop that never drains the note (each COLLECT drains it,
 *      but the hint round re-runs and the loop keeps cycling).
 *
 * This test drives the REAL handleWait (AWAIT) with a steering note in the
 * queue to confirm the immediate re-wake, and asserts the fix: after 停止, the
 * lingering note must be drained so AWAIT does NOT re-wake on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      setAuto: vi.fn(),
      getAuto: vi.fn(() => false),
      log: vi.fn(),
      flushOutput: vi.fn(),
      verbose: vi.fn(),
      brief: vi.fn(),
    },
  };
});

vi.mock('../../../loop/auto-state.js', () => ({
  autoState: {
    getAuto: vi.fn(() => true),
    setAuto: vi.fn(),
    resetStreak: vi.fn(),
  },
}));

// Mock the serve hub so getServeHub().isRunning()/getSteeringNotes()/drainSteering()
// are controllable.
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(),
}));

// --- Imports after mocks -----------------------------------------------------
import { handleWait } from '../../../loop/states/await.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { autoState } from '../../../loop/auto-state.js';
import { getServeHub } from '../../../serve/serve-registry.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';

describe('AWAIT re-entry on a lingering steering note (post-停止 tight loop)', () => {
  let hub: {
    isRunning: ReturnType<typeof vi.fn>;
    getSteeringNotes: ReturnType<typeof vi.fn>;
    drainSteering: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    hub = {
      isRunning: vi.fn(() => true),
      getSteeringNotes: vi.fn(() => []),
      drainSteering: vi.fn(() => []),
    };
    vi.mocked(getServeHub).mockReturnValue(hub as never);
  });

  it('AWAIT immediately re-wakes on a lingering steering note (the tight-loop trigger)', async () => {
    // A steering note is still in the queue (arrived during the hint round,
    // never drained after 停止).
    hub.getSteeringNotes.mockReturnValue(['stale note']);

    const env = createMockMachineEnv({ triologue: {} as never });
    const turn = createTurnVars();
    const chat = createChatData();

    // awaitTeammates polls every 1s; the first tick is immediate, so a
    // pending steering note is caught without delay.
    const result = await Promise.race([
      handleWait(env, turn, chat),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);

    // AWAIT returns COLLECT immediately (re-wake on the stale note) — this is
    // the tight-loop trigger: COLLECT → hint round → (no drain) → AWAIT → ...
    expect(result).toBe(AgentState.COLLECT);
  });

  it('AWAIT does NOT re-wake when the steering queue is empty (post-fix behavior)', async () => {
    // After the fix, the lingering note is drained at STOP/PROMPT, so the
    // queue is empty and AWAIT blocks (no immediate re-wake). Override the
    // mock awaitTeammates to simulate real polling: it blocks (never resolves)
    // when no steering note is pending, exactly like the real 1s poll loop.
    const env = createMockMachineEnv({ triologue: {} as never });
    env.ctx.team.awaitTeammates = vi.fn(
      () => new Promise<'timeout'>(() => { /* never resolves — blocks */ }),
    ) as never;

    const turn = createTurnVars();
    const chat = createChatData();

    // AWAIT should block (not return COLLECT immediately). Race against a
    // short timeout — if it returns COLLECT, the re-wake bug is present.
    const result = await Promise.race([
      handleWait(env, turn, chat),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    // With an empty queue and auto still on, AWAIT keeps blocking (timeout).
    expect(result).toBe('timeout');
  });
});
