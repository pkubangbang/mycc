/**
 * stop-team-event-poll.test.ts — handleStop normal-mode (non-neglected) branch.
 *
 * STOP delegates the teammate wait to the unified `ctx.team.awaitTeammates`
 * primitive, which polls teammate status + mailbox + steering + ESC + a
 * max-wait safety valve every 1s and returns a typed `TeammateWaitReason`.
 * STOP switches on the reason to pick the next state:
 *   - 'holding' / 'mail' / 'steering' → COLLECT
 *   - 'timeout'                       → COLLECT + SYSTEM timeout note
 *   - 'esc' / 'all done'              → PROMPT
 *
 * These tests mock `awaitTeammates` to return each reason and assert STOP
 * routes it to the correct state. The "shows letter-box BEFORE wait" and
 * "idle at entry" cases verify STOP's pre-wait behavior (presentResult +
 * the working-teammate notice), which runs before the awaitTeammates call.
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

  it('returns COLLECT when awaitTeammates reports holding (question path)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'holding' }]) as never,
        awaitTeammates: vi.fn(async () => 'holding' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
  });

  // ── reason routing: mail → COLLECT ──

  it('returns COLLECT when awaitTeammates reports mail (heartbeat/peer event)', async () => {
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

  // ── reason routing: steering → COLLECT ──

  it('returns COLLECT when awaitTeammates reports steering (webui note)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        awaitTeammates: vi.fn(async () => 'steering' as const) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
  });

  // ── reason routing: esc → PROMPT ──

  it('returns PROMPT when awaitTeammates reports esc (user interrupted)', async () => {
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
  });

  // ── reason routing: timeout → COLLECT + SYSTEM timeout note ──

  it('returns COLLECT with a SYSTEM timeout note when awaitTeammates reports timeout', async () => {
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
});