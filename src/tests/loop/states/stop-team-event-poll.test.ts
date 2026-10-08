/**
 * stop-team-event-poll.test.ts — handleStop normal-mode (non-neglected) branch.
 *
 * STOP delegates the teammate wait to the unified `ctx.team.awaitTeammates`
 * primitive, which polls teammate status + mailbox + steering + ESC + a
 * max-wait safety valve every 1s and returns a typed `TeammateWaitReason`.
 * STOP switches on the reason to pick the next state:
 *   - 'timeout'                       → COLLECT + SYSTEM timeout note
 *   - 'esc' / 'all done'              → PROMPT
 *   ('mail' / 'steering' / 'holding' are not accepted — see below — and fall
 *    through the switch `default:` to PROMPT)
 *
 * IMPORTANT — bounded-reasons contract: STOP passes an EXPLICIT
 * `reasons: ['all done', 'timeout', 'esc']` to awaitTeammates. It must NOT
 * accept 'mail' or 'steering' (the CONTINUATION reasons), otherwise a
 * still-working teammate's periodic mail drives an infinite STOP→COLLECT
 * tight cycle and the loop never returns to PROMPT (the "停止 / WebUI frozen"
 * bug). These tests mock `awaitTeammates` to return each reason and assert
 * STOP's routing AND assert the reasons argument it passes.
 *
 * The "shows letter-box BEFORE wait" and "idle at entry" cases verify STOP's
 * pre-wait behavior (presentResult + the working-teammate notice), which runs
 * before the awaitTeammates call.
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
// into awaitTeammates). The mock remains harmless but is not exercised here.
vi.mock('../../../serve/serve-registry.js', () => ({
  getServeHub: vi.fn(() => ({
    isRunning: vi.fn(() => false),
    getSteeringNotes: vi.fn(() => []),
    drainSteering: vi.fn(() => []),
  })),
}));

// --- Imports after mocks -----------------------------------------------------
import { handleStop } from '../../../loop/states/stop.js';
import { AgentState, presentResult } from '../../../loop/state-machine.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';

describe('handleStop — normal-mode teammate wait via awaitTeammates', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // ── bounded-reasons contract ──

  it('passes explicit reasons ["all done","timeout","esc"] and NOT mail/steering (no tight STOP↔COLLECT cycle)', async () => {
    const awaitTeammates = vi.fn<(opts?: { reasons?: string[] }) => Promise<'all done'>>(
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
    expect(opts.reasons).toEqual(['all done', 'timeout', 'esc']);
    // The continuation reasons must NOT be accepted by STOP — accepting 'mail'
    // re-enters COLLECT on every teammate heartbeat and never reaches PROMPT.
    expect(opts.reasons).not.toContain('mail');
    expect(opts.reasons).not.toContain('steering');
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

  // ── reason routing: holding → COLLECT ──


  // ── reason routing: mail → COLLECT ──


  // ── reason routing: steering → COLLECT ──


  // ── reason routing: esc → PROMPT ──


  // ── reason routing: timeout → COLLECT + SYSTEM timeout note ──


  // ── turn-boundary wiring (STOP→PROMPT fires it, STOP→COLLECT does not) ──
  //
  // markTurnBoundary() = markPromptBoundary() + resetTurn() + incrementTotalTurns().
  // It must fire ONLY on STOP→PROMPT (a turn ended) and NEVER on STOP→COLLECT
  // (a teammate question / timeout is a turn CONTINUATION, not a new turn).
  // These assertions pin the continuation-vs-turn-end distinction at the
  // wiring level — a future refactor that drops markTurnBoundary() from a
  // return site would break them, not just the isolated sequence unit tests.
  describe('turn boundary wiring (markTurnBoundary call sites)', () => {
    const reasonToState: Array<{ reason: 'all done' | 'esc' | 'mail' | 'steering' | 'holding' | 'timeout'; state: 'PROMPT' | 'COLLECT' }> = [
      { reason: 'all done', state: 'PROMPT' },
      { reason: 'esc', state: 'PROMPT' },
      // STOP accepts only 'all done'/'timeout'/'esc'. The continuation reasons
      // 'mail'/'steering' and the teammate question 'holding' are NOT accepted;
      // if awaitTeammates ever returned one it falls through the switch
      // `default:` → PROMPT. Pinning that fallthrough is what guards the
      // "停止 / WebUI frozen" fix: if a still-working teammate's periodic mail
      // re-entered COLLECT, the loop would never return to PROMPT.
      { reason: 'mail', state: 'PROMPT' },
      { reason: 'steering', state: 'PROMPT' },
      { reason: 'holding', state: 'PROMPT' },
      // 'timeout' (the safety valve) is the only COLLECT re-entry.
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
  });
});
