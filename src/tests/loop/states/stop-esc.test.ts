/**
 * stop-esc.test.ts — handleStop: neglected mode at entry (ESC wrap-up branch).
 *
 * Code path under test (stop.ts:21-34):
 *   if (agentIO.isNeglectedMode()) {
 *     agentIO.setNeglectedMode(false); // Clear FIRST for isInteractionMode()
 *     const teammates = ctx.team.listTeammates();
 *     if (teammates.some((t) => t.status === 'working')) {
 *       agentIO.log(chalk.yellow('teammates still working (use /team to check status)'));
 *     }
 *     agentIO.flushOutput();
 *     presentResult(triologue);
 *     return AgentState.PROMPT;
 *   }
 *
 * This is the neglected-mode wrap-up: LLM produced a text-only response (no
 * tools) after user pressed ESC. The text IS the final response.
 *
 * Normal-mode branch (awaitTeam) is also tested for the "all done" path.
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
  },
  presentResult: vi.fn(),
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
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createPassData, createMockMachineEnv } from '../esc-test-helpers.js';
import { createMockContext } from '../../test-utils/mock-context.js';

describe('handleStop — neglected mode at entry (ESC wrap-up)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  it('should clear neglected mode FIRST, flush output, present result, and return PROMPT', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData();

    // ESC pressed — neglected mode active at entry
    agentIO.setNeglectedMode(true);

    const result = await handleStop(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // Neglected mode cleared
    expect(agentIO.isNeglectedMode()).toBe(false);
    // flushOutput called (flushes the wrap-up text)
    expect(agentIO.flushOutput).toHaveBeenCalledTimes(1);
    // presentResult called with triologue
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });

  it('should log "teammates still working" when a teammate has status working', async () => {
    const ctx = createMockContext({
      team: {
        listTeammates: vi.fn(() => [
          { name: 'dev1', status: 'working' },
          { name: 'dev2', status: 'idle' },
        ]) as never,
      },
    });
    const env = createMockMachineEnv({ triologue, ctxOptions: { team: ctx.team } });
    // Re-wire ctx since createMockMachineEnv builds its own ctx from ctxOptions
    env.ctx = ctx;
    const turn = createTurnVars();
    const pass = createPassData();

    agentIO.setNeglectedMode(true);

    await handleStop(env, turn, pass);

    // agentIO.log called with the teammates-still-working message
    expect(agentIO.log).toHaveBeenCalledTimes(1);
    const logMsg = vi.mocked(agentIO.log).mock.calls[0][0] as string;
    expect(logMsg).toContain('teammates still working');
  });

  it('should NOT log teammates message when no teammate is working', async () => {
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
    const pass = createPassData();

    agentIO.setNeglectedMode(true);

    await handleStop(env, turn, pass);

    expect(agentIO.log).not.toHaveBeenCalled();
    // Still presents result and returns PROMPT
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });

  it('should return PROMPT on normal-mode "all done" path (presentResult, no neglected)', async () => {
    const ctx = createMockContext({
      team: {
        awaitTeam: vi.fn(async () => ({ result: 'all done' })) as never,
      },
    });
    const env = createMockMachineEnv({ triologue });
    env.ctx = ctx;
    const turn = createTurnVars();
    const pass = createPassData();

    // NOT in neglected mode — exercises the normal awaitTeam branch
    agentIO.setNeglectedMode(false);

    const result = await handleStop(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    expect(presentResult).toHaveBeenCalledWith(triologue);
  });
});