/**
 * stop-team-await.test.ts — handleStop normal-mode (non-neglected) branch.
 *
 * Fills the unit-test gap that let two bugs ship (commit f7ca876):
 *
 * 1. LETTER-BOX ORDERING — presentResult() must run BEFORE awaitTeam()
 *    resolves, so the user sees the final response immediately instead of
 *    after all teammates idle (the lead looked "frozen"). The pre-fix code
 *    called awaitTeam() first, then presentResult() only on the 'all done'
 *    path — so the letter-box was suppressed the entire wait.
 *
 * 2. STEERING-NOTE ROUTING — a WebUI steering note queued during the await
 *    is NOT a mail, so the old `result === 'got question' || mail.hasNewMails()`
 *    check missed it. The fix added a steerPending check so STOP routes to
 *    COLLECT (whose 2c block drains steering as a REMINDER) even when
 *    awaitTeam reports 'all done'.
 *
 * Sibling: stop-esc.test.ts covers the neglection branch. This file covers
 * the normal branch with mocked teammate state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// serve-registry: controllable isRunning() + getSteeringNotes(). stop.ts now
// imports getServeHub; stop-esc.test.ts did not mock it (it never reached the
// steerPending check). Default: not running, no notes.
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

describe('handleStop — normal-mode (non-neglected) team-await branch', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
    // Default: no WebUI, no steering notes.
    (serveRegistry as unknown as { __setRunning: (v: boolean) => void }).__setRunning(false);
    (serveRegistry as unknown as { __setNotes: (n: string[]) => void }).__setNotes([]);
  });

  // ── Bug 1: letter-box ordering ──

  it('shows the letter-box (presentResult) BEFORE awaitTeam resolves — not after', async () => {
    // The ordering proof: awaitTeam's mock inspects whether presentResult has
    // already been called AT THE MOMENT awaitTeam is entered. Pre-fix code
    // called awaitTeam first, so this would observe presentResult NOT called.
    let presentResultCalledBeforeAwait = false;
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => {
          presentResultCalledBeforeAwait = vi.mocked(presentResult).mock.calls.length > 0;
          return { result: 'all done' };
        }) as never,
        listTeammates: vi.fn(() => []) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    await handleStop(env, createTurnVars(), createChatData());

    expect(presentResultCalledBeforeAwait).toBe(true);
  });

  it('returns PROMPT and shows the letter-box on the "all done" path', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
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

  it('shows the letter-box even when a teammate is still working (await blocks)', async () => {
    // A working teammate makes awaitTeam block in production; here it still
    // resolves 'all done', but the point is the letter-box shows regardless.
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'working' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    await handleStop(env, createTurnVars(), createChatData());

    expect(presentResult).toHaveBeenCalledWith(triologue);
  });

  // ── "awaiting teammate(s)" notice ──

  it('logs an "awaiting teammate(s)" notice when a teammate is working', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'working' },
          { name: 'dev2', status: 'idle' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    await handleStop(env, createTurnVars(), createChatData());

    const logCalls = vi.mocked(agentIO.log).mock.calls;
    expect(logCalls.length).toBeGreaterThanOrEqual(1);
    const awaitingMsg = logCalls.find((c) =>
      (c[0] as string).includes('awaiting teammate'),
    );
    expect(awaitingMsg).toBeDefined();
  });

  it('does NOT log the awaiting notice when no teammate is working', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'idle' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    await handleStop(env, createTurnVars(), createChatData());

    const logCalls = vi.mocked(agentIO.log).mock.calls;
    const awaitingMsg = logCalls.find((c) =>
      (c[0] as string).includes('awaiting teammate'),
    );
    expect(awaitingMsg).toBeUndefined();
  });

  // ── Bug 2: steering-note routing ──

  it('routes to COLLECT when a steering note is pending, even if awaitTeam reports "all done"', async () => {
    // The bug: steering notes are not mails, so the old mail-only check
    // returned PROMPT (letter-box shown, turn ends) and the note piled up.
    // The fix: steerPending → COLLECT so COLLECT 2c drains it as a REMINDER.
    (serveRegistry as unknown as { __setRunning: (v: boolean) => void }).__setRunning(true);
    (serveRegistry as unknown as { __setNotes: (n: string[]) => void }).__setNotes(['stop and review the diff']);

    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
        listTeammates: vi.fn(() => []) as never,
      },
      mail: { hasNewMails: vi.fn(() => false) } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
  });

  it('routes to COLLECT on "got question" regardless of steering state', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'got question' })) as never,
        listTeammates: vi.fn(() => []) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
  });

  it('routes to COLLECT when new mail is waiting (awaitTeam "all done" but mail arrived)', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
        listTeammates: vi.fn(() => []) as never,
      },
      mail: { hasNewMails: vi.fn(() => true) } as never,
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.COLLECT);
  });

  // ── timeout path ──

  it('routes to COLLECT and notes a SYSTEM timeout message on awaitTeam "timeout"', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'timeout' })) as never,
        listTeammates: vi.fn(() => []) as never,
        printTeam: vi.fn(() => 'Team:\n  dev1 (coder): working') as never,
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

  // ── "no teammates" short-circuit ──

  it('returns PROMPT and shows the letter-box on the "no teammates" path', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'no teammates' })) as never,
        listTeammates: vi.fn(() => []) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;

    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(result).toBe(AgentState.PROMPT);
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });
});