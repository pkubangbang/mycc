/**
 * stop-team-event-poll.test.ts — handleStop normal-mode (non-neglected) branch
 * with the event-polling teammate wait.
 *
 * Replaces stop-team-await.test.ts, which mocked the one-shot `awaitTeam()`.
 * STOP no longer calls `awaitTeam()`; it polls live teammate status + mailbox +
 * steering on every 1s tick (mirroring AWAIT's eventPending() pattern, but
 * working in manual mode). This file tests that polling loop.
 *
 * The loop's only exits are explicit events:
 *   - ESC pressed            → PROMPT
 *   - a teammate is holding  → COLLECT
 *   - no teammate is working → PROMPT (all done)
 *   - new mail arrived       → COLLECT (heartbeat / watchdog)
 *   - steering note queued   → COLLECT
 *   - max-wait exceeded      → COLLECT + SYSTEM timeout note (safety valve)
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

// serve-registry: controllable isRunning() + getSteeringNotes().
vi.mock('../../../serve/serve-registry.js', () => {
  let running = false;
  let notes: string[] = [];
  return {
    getServeHub: vi.fn(() => ({
      isRunning: vi.fn(() => running),
      getSteeringNotes: vi.fn(() => notes),
      drainSteering: vi.fn(() => notes),
    })),
    // test-only setters (hoisted above the import below)
    __setRunning: vi.fn((v: boolean) => { running = v; }),
    __setNotes: vi.fn((n: string[]) => { notes = n; }),
  };
});

// --- Imports after mocks -----------------------------------------------------
import { handleStop } from '../../../loop/states/stop.js';
import { AgentState, presentResult } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';
// Cast the mocked module to reach the test-only setters.
import * as serveRegistry from '../../../serve/serve-registry.js';

// The polling loop sleeps 1s between ticks; the max-wait safety valve is 10min.
const POLL_MS = 1000;
const MAX_WAIT_MS = 10 * 60 * 1000;

describe('handleStop — normal-mode event-polling teammate wait', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    triologue = new Triologue();
    // Default: no WebUI, no steering notes.
    (serveRegistry as unknown as { __setRunning: (v: boolean) => void }).__setRunning(false);
    (serveRegistry as unknown as { __setNotes: (n: string[]) => void }).__setNotes([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── letter-box ordering (kept from the old test) ──

  it('shows the letter-box (presentResult) BEFORE the wait begins', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => []) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.PROMPT);
    expect(presentResult).toHaveBeenCalledTimes(1);
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });

  // ── Case 1: teammate idle at entry → PROMPT immediately ──

  it('returns PROMPT immediately when no teammate is working at entry', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'idle' },
          { name: 'dev2', status: 'shutdown' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.PROMPT);
    // No poll tick should have been needed.
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── Case 2: working → idle mid-poll → PROMPT ──

  it('returns PROMPT when a working teammate goes idle mid-poll (re-read catches transition)', async () => {
    const statuses = [
      [{ name: 'dev1', status: 'working' }],
      [{ name: 'dev1', status: 'idle' }],
    ];
    const listTeammates = vi.fn(() => statuses.shift() ?? []);
    const ctx = createMockContext({
      team: { listTeammates: listTeammates as never },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const promise = handleStop(env, createTurnVars(), createChatData());

    // First tick: teammate working → loop keeps polling.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Second tick: teammate now idle → returns PROMPT.
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(await promise).toBe(AgentState.PROMPT);
    expect(listTeammates).toHaveBeenCalledTimes(2);
  });

  // ── Case 3: working, mail arrives → COLLECT ──

  it('returns COLLECT when new mail arrives during the wait (heartbeat event)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
      },
      mail: {
        hasNewMails: vi.fn(() => true),
      } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const promise = handleStop(env, createTurnVars(), createChatData());

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(await promise).toBe(AgentState.COLLECT);
  });

  // ── Case 4: holding → COLLECT immediately ──

  it('returns COLLECT immediately when a teammate is holding (question path)', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'holding' }]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── Case 5: ESC pressed during wait → PROMPT ──

  it('returns PROMPT when ESC is pressed during the wait', async () => {
    const isNeglected = vi
      .fn()
      .mockReturnValueOnce(false) // first tick: not neglected
      .mockReturnValueOnce(true); // second tick: ESC pressed
    vi.mocked(agentIO.isNeglectedMode).mockImplementation(isNeglected);

    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const promise = handleStop(env, createTurnVars(), createChatData());

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(await promise).toBe(AgentState.PROMPT);
  });

  // ── Case 6: steering note arrives during wait → COLLECT ──

  it('returns COLLECT when a steering note is queued during the wait', async () => {
    (serveRegistry as unknown as { __setRunning: (v: boolean) => void }).__setRunning(true);
    (serveRegistry as unknown as { __setNotes: (n: string[]) => void }).__setNotes(['stop and review']);

    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const promise = handleStop(env, createTurnVars(), createChatData());

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(await promise).toBe(AgentState.COLLECT);
  });

  // ── Case 7: working with passed deadline (stale ETA) → keeps polling, NOT PROMPT ──

  it('keeps polling (does NOT return PROMPT) while a teammate stays working with a passed deadline', async () => {
    // The reproduction-1 guard: the old code returned 'all done' → PROMPT when
    // the deadline passed. The new loop keeps polling until the teammate goes
    // idle or an event arrives. Here the teammate stays 'working' for several
    // ticks with no mail/steering — the loop must NOT exit to PROMPT.
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const promise = handleStop(env, createTurnVars(), createChatData());

    // Advance several ticks well past any plausible deadline; teammate still working.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }

    // The loop is still pending (no exit event) — it has NOT returned PROMPT.
    // We can't await `promise` (it would hang), so assert it is still unresolved.
    let settled = false;
    promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  });

  // ── Case 8: max-wait safety valve → COLLECT + SYSTEM timeout note ──

  it('returns COLLECT with a SYSTEM timeout note when the max-wait is exceeded', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [{ name: 'dev1', status: 'working' }]) as never,
        printTeam: vi.fn(() => 'Team:\n  dev1 (coder): working') as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const promise = handleStop(env, createTurnVars(), createChatData());

    // Advance past the max-wait while the teammate stays working and no event fires.
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + POLL_MS);

    expect(await promise).toBe(AgentState.COLLECT);
    expect(triologue.note).toHaveBeenCalledWith(
      'SYSTEM',
      expect.stringContaining('Timeout waiting for teammates'),
    );
  });
});
