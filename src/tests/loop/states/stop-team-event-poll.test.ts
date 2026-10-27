/**
 * stop-team-event-poll.test.ts — handleStop normal-mode (non-neglected) branch.
 *
 * STOP delegates the teammate wait to the unified `ctx.team.awaitTeammates`
 * primitive, which polls teammate status + mailbox + steering + ESC + a
 * max-wait safety valve every 1s and returns a typed `TeammateWaitReason`.
 *
 * The wait is MODE-AWARE (see stop.ts):
 *   - INTERACTIVE (auto off): STOP runs a BOUNDED wait
 *     (`reasons: ['all done','holding','mail','steering','timeout']`,
 *      `timeoutMs: 60_000`) and routes:
 *        · 'holding' / 'mail' / 'steering' → COLLECT (continue the turn —
 *          a teammate needs the lead to act; this is STOP's whole job)
 *        · 'timeout'                       → COLLECT + SYSTEM timeout note
 *        · 'esc' / 'all done'             → PROMPT
 *   - AUTO (auto on): STOP SKIPS the wait entirely and returns PROMPT. PROMPT
 *     then redirects to AWAIT, which owns the unbounded teammate-event wait.
 *     Skipping here is what prevents a still-working teammate's periodic mail
 *     (~30s heartbeats) from driving an infinite STOP→COLLECT→LLM→STOP cycle
 *     that never reaches PROMPT (the "停止 / WebUI frozen" bug).
 *
 * The user interrupt (ESC / 停止) is NOT expressed in `reasons` — it is a
 * preemptive signal awaitTeammates checks first every tick. These tests assert
 * STOP's routing table, the reasons argument it passes in interactive mode, and
 * that auto mode short-circuits the wait.
 *
 * The "shows letter-box BEFORE wait" and "idle at entry" cases verify STOP's
 * pre-wait behavior (presentResult + the working-teammate notice).
 *
 * Sibling: stop-esc.test.ts covers the neglection branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

// agentIO: normal mode (NOT neglected) for all tests here.
vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => false),
    setNeglectedMode: vi.fn(),
    log: vi.fn(),
    flushOutput: vi.fn(),
  },
}));

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

// serve-registry is no longer imported by stop.ts (the steering check moved
// into awaitTeammates). The mock remains harmless but is not exercised here;
// the old getSteeringNotes/drainSteering stub entries were pruned when those
// dead hub facades were removed (hub keeps pushSteer/resolveSteering only).
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(() => ({
    isRunning: vi.fn(() => false),
  })),
}));

// --- Imports after mocks -----------------------------------------------------
import { handleStop } from '../../../loop/states/stop.js';
import { AgentState, presentResult } from '../../../loop/state-machine.js';
import { Triologue } from '../../../loop/triologue.js';
import { autoState } from '../../../loop/auto-state.js';
import { agentIO } from '../../../loop/agent-io.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';

describe('handleStop — normal-mode teammate wait via awaitTeammates', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
    // All tests here run in INTERACTIVE mode unless they opt into auto.
    autoState.setAuto(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    // autoState is the real singleton (auto-state.js is not mocked) — reset it
    // so a test that turns auto on cannot leak into the next.
    autoState.setAuto(false);
  });

  // ── letter-box ordering ──

  it('shows the letter-box (presentResult) BEFORE the wait begins', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => []) as never,
        awaitTeammates: vi.fn(async () => 'all done' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.PROMPT);
    expect(presentResult).toHaveBeenCalledTimes(1);
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });

  // ── interactive-mode reasons contract ──

  it('passes the full teammate-event reasons and a short timeout (bounded interactive wait)', async () => {
    const awaitTeammates = vi.fn<(opts?: { reasons?: string[]; timeoutMs?: number }) => Promise<'all done'>>(
      async () => 'all done' as const,
    );
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        awaitTeammates: awaitTeammates as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    await handleStop(env, createTurnVars(), createChatData());

    expect(awaitTeammates).toHaveBeenCalledTimes(1);
    const opts = awaitTeammates.mock.calls[0][0]!;
    // The teammate-event set is accepted so the lead wakes promptly on mail.
    // 'esc' is NOT in the list: the interrupt is handled first-tick, not here.
    expect(opts.reasons).toEqual(['all done', 'holding', 'mail', 'steering', 'timeout']);
    expect(opts.reasons).not.toContain('esc');
    // The bound (not the reasons list) keeps the prompt from being deferred
    // indefinitely.
    expect(opts.timeoutMs).toBe(60_000);
  });

  // ── REGRESSION: teammate mail wakes STOP → COLLECT ──

  it('wakes on teammate mail and routes to COLLECT (lead must respond to teammates)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        awaitTeammates: vi.fn(async () => 'mail' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
  });

  it('wakes on a teammate question (holding) and on steering, both → COLLECT', async () => {
    for (const reason of ['holding', 'steering'] as const) {
      vi.clearAllMocks();
      const ctx = createMockContext({
        team: {
          listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
          awaitTeammates: vi.fn(async () => reason) as never,
        },
      });
      const env = createMockMachineEnv({ triologue });
      env.ctx = ctx;

      const result = await handleStop(env, createTurnVars(), createChatData());
      expect(result).toBe(AgentState.COLLECT);
    }
  });

  // ── reason routing: all done → PROMPT ──

  it('returns PROMPT when awaitTeammates reports all done', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'idle' },
          { name: 'dev2', status: 'shutdown' },
        ]) as never,
        awaitTeammates: vi.fn(async () => 'all done' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.PROMPT);
  });

  // ── REGRESSION: esc → PROMPT (interactive), neglected mode cleared ──

  it('returns PROMPT on esc and clears neglected mode (停止 reaches the prompt)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        awaitTeammates: vi.fn(async () => 'esc' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.PROMPT);
    expect(agentIO.setNeglectedMode).toHaveBeenCalledWith(false);
  });

  // ── REGRESSION: auto mode skips the wait entirely (no STOP→COLLECT cycle) ──

  it('in AUTO mode skips the teammate wait and returns PROMPT (AWAIT owns the event wait)', async () => {
    autoState.setAuto(true);

    const awaitTeammates = vi.fn(async () => 'mail' as const);
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        awaitTeammates: awaitTeammates as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    // PROMPT (which redirects to AWAIT in auto mode) — NOT COLLECT. The wait
    // was never entered, so a still-working teammate's periodic mail can never
    // drive a STOP→COLLECT tight cycle.
    expect(result).toBe(AgentState.PROMPT);
    expect(awaitTeammates).not.toHaveBeenCalled();
  });

  // ── reason routing: timeout → COLLECT + SYSTEM timeout note ──

  it('routes timeout → COLLECT and writes a SYSTEM timeout note', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        printTeam: vi.fn(() => 'Team:\n  dev1 (coder): working') as never,
        awaitTeammates: vi.fn(async () => 'timeout' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
    expect(triologue.note).toHaveBeenCalledWith(
      'SYSTEM',
      expect.stringContaining('Timeout waiting for teammates'),
    );
  });

  // ── turn-boundary wiring (STOP→PROMPT fires it, STOP→COLLECT does not) ──
  //
  // markTurnBoundary() = markPromptBoundary() + resetTurn() + incrementTotalTurns().
  // It must fire ONLY on STOP→PROMPT (a turn ended) and NEVER on STOP→COLLECT
  // (a teammate event / timeout is a turn CONTINUATION, not a new turn). The
  // AUTO-mode early return also ends the turn, so it fires there too.
  describe('turn boundary wiring (markTurnBoundary call sites)', () => {
    const reasonToState: Array<{ reason: 'all done' | 'esc' | 'mail' | 'steering' | 'holding' | 'timeout'; state: 'PROMPT' | 'COLLECT' }> = [
      { reason: 'all done', state: 'PROMPT' },
      { reason: 'esc', state: 'PROMPT' },
      // Teammate events continue the turn.
      { reason: 'mail', state: 'COLLECT' },
      { reason: 'steering', state: 'COLLECT' },
      { reason: 'holding', state: 'COLLECT' },
      // 'timeout' (the safety valve) also re-enters COLLECT.
      { reason: 'timeout', state: 'COLLECT' },
    ];

    for (const { reason, state } of reasonToState) {
      const fires = state === 'PROMPT';
      it(`${fires ? 'fires' : 'does NOT fire'} the turn boundary on STOP→${state} (reason: ${reason})`, async () => {
        const ctx = createMockContext({
          team: {
            listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
            printTeam: vi.fn(() => 'Team:\n  dev1 (coder): working') as never,
            awaitTeammates: vi.fn(async () => reason) as never,
          },
        });
        const env = createMockMachineEnv({ triologue });
        env.ctx = ctx;

        const result = await handleStop(env, createTurnVars(), createChatData());

        expect(result).toBe(state === 'PROMPT' ? AgentState.PROMPT : AgentState.COLLECT);

        if (fires) {
          // STOP→PROMPT: the boundary helper ran all three of its steps.
          expect(env.sequence.markPromptBoundary).toHaveBeenCalledTimes(1);
          expect(env.sequence.incrementTotalTurns).toHaveBeenCalledTimes(1);
          expect(env.hookExecutor.resetTurn).toHaveBeenCalledTimes(1);
        } else {
          // STOP→COLLECT: a continuation — NONE of the boundary steps ran.
          expect(env.sequence.markPromptBoundary).not.toHaveBeenCalled();
          expect(env.sequence.incrementTotalTurns).not.toHaveBeenCalled();
          expect(env.hookExecutor.resetTurn).not.toHaveBeenCalled();
        }
      });
    }

    it('fires the turn boundary on the AUTO-mode early return', async () => {
      autoState.setAuto(true);
      const ctx = createMockContext({
        team: {
          listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
          awaitTeammates: vi.fn(async () => 'mail' as const) as never,
        },
      });
      const env = createMockMachineEnv({ triologue });
      env.ctx = ctx;

      const result = await handleStop(env, createTurnVars(), createChatData());

      expect(result).toBe(AgentState.PROMPT);
      expect(env.sequence.markPromptBoundary).toHaveBeenCalledTimes(1);
      expect(env.sequence.incrementTotalTurns).toHaveBeenCalledTimes(1);
      expect(env.hookExecutor.resetTurn).toHaveBeenCalledTimes(1);
    });
  });
});
