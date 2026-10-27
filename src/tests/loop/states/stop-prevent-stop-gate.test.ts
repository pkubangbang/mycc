/**
 * stop-prevent-stop-gate.test.ts — handleStop + the pinned-todo stop guard.
 *
 * Regression cover for the guard's WIRING, which the pure gate suite
 * (stop-prevent-stop.test.ts) cannot see: every other handleStop suite mocks
 * `checkPreventStop` to `{block:false}`, so before this file a regression that
 * returned PROMPT instead of COLLECT, dropped the SYSTEM note, or started
 * calling `markTurnBoundary()` for a continuing turn would have passed the
 * whole suite.
 *
 * The contract under test (stop.ts, the "Pinned-todo stop guard" block):
 *   guard.block === true
 *     → triologue.note('SYSTEM', guard.note)
 *     → return AgentState.COLLECT          (the turn CONTINUES)
 *     → NO markTurnBoundary() / presentResult()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

// agentIO: normal mode — a guard hold is NOT an ESC-neglection path.
vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => false),
    setNeglectedMode: vi.fn(),
    log: vi.fn(),
    flushOutput: vi.fn(),
    getAuto: vi.fn(() => false),
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
  loader: { getToolsForScope: vi.fn(() => []) },
}));

vi.mock('../../../engine/chat-helpers.js', () => ({
  stopSpinner: vi.fn(),
}));

// THE GATE UNDER TEST — mocked at the module boundary so each case can choose
// `block: true` / `block: false` without driving forkChat.
vi.mock('../../../loop/states/stop-prevent-stop.js', () => ({
  checkPreventStop: vi.fn(async () => ({ block: false })),
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

// Team wait: the guard must be decided BEFORE anyone blocks on teammates.
vi.mock('../../../loop/../context/parent/team.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, awaitTeammates: vi.fn(async () => 'none') };
});

// --- Imports after mocks -----------------------------------------------------
import { handleStop } from '../../../loop/states/stop.js';
import { AgentState, presentResult } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { checkPreventStop } from '../../../loop/states/stop-prevent-stop.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv } from '../esc-test-helpers.js';

const GUARD_NOTE =
  'Stop prevented — pinned guard #2 "migration" requires work to continue.\n' +
  'preventStop: "until the migration is verified".';

describe('handleStop — pinned-todo stop guard wiring', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
    vi.mocked(agentIO.isNeglectedMode).mockReturnValue(false);
    vi.mocked(checkPreventStop).mockResolvedValue({ block: false });
    // Present a normal "turn finished" shape: last role is assistant.
    vi.mocked(triologue.getLastRole).mockReturnValue('assistant');
  });

  it('a held guard continues the turn: SYSTEM note + COLLECT, never PROMPT', async () => {
    vi.mocked(checkPreventStop).mockResolvedValue({ block: true, note: GUARD_NOTE });

    const env = createMockMachineEnv({ triologue });
    const result = await handleStop(env, createTurnVars(), createChatData());

    // THE contract: COLLECT means "the turn continues", not "the turn ended".
    expect(result).toBe(AgentState.COLLECT);
    expect(result).not.toBe(AgentState.PROMPT);

    // The note is what re-engages the model with a reason. It must be a SYSTEM
    // note (rendered as a user-role message by triologue.note) naming the guard.
    expect(triologue.note).toHaveBeenCalledTimes(1);
    const [category, body] = vi.mocked(triologue.note).mock.calls[0] as [string, string];
    expect(category).toBe('SYSTEM');
    expect(body).toBe(GUARD_NOTE);
  });

  it('a held guard is NOT a turn boundary: markTurnBoundary and presentResult never run', async () => {
    vi.mocked(checkPreventStop).mockResolvedValue({ block: true, note: GUARD_NOTE });

    const env = createMockMachineEnv({ triologue });
    const markTurnBoundary = vi.fn();
    (env.sequence as unknown as Record<string, unknown>).markTurnBoundary = markTurnBoundary;

    await handleStop(env, createTurnVars(), createChatData());

    // A continuation must not reset turn events nor increment totalTurns —
    // both hang off markTurnBoundary.
    expect(markTurnBoundary).not.toHaveBeenCalled();
    // And no letter-box: the turn resumes immediately, so printing a result
    // would be a lie the user sees twice per iteration.
    expect(presentResult).not.toHaveBeenCalled();
  });

  it('a guard hold wins over the auto-mode early return', async () => {
    vi.mocked(checkPreventStop).mockResolvedValue({ block: true, note: GUARD_NOTE });
    vi.mocked(agentIO.getAuto).mockReturnValue(true);

    const env = createMockMachineEnv({ triologue });
    const result = await handleStop(env, createTurnVars(), createChatData());

    // Long-horizon runs live in --auto/--daemon; the gate sits BEFORE the auto
    // branch, so a hold must still return COLLECT rather than PROMPT/await.
    expect(result).toBe(AgentState.COLLECT);
  });

  it('ESC still wins: in neglected mode the guard is never consulted', async () => {
    vi.mocked(checkPreventStop).mockResolvedValue({ block: true, note: GUARD_NOTE });
    vi.mocked(agentIO.isNeglectedMode).mockReturnValue(true);

    const env = createMockMachineEnv({ triologue });
    const result = await handleStop(env, createTurnVars(), createChatData());

    // The neglection block precedes the gate, so a user who pressed ESC is
    // never trapped by a guard.
    expect(checkPreventStop).not.toHaveBeenCalled();
    expect(result).toBe(AgentState.PROMPT);
  });

  it('no held guard: the gate runs and the turn ends normally', async () => {
    vi.mocked(checkPreventStop).mockResolvedValue({ block: false });

    const env = createMockMachineEnv({ triologue });
    const result = await handleStop(env, createTurnVars(), createChatData());

    expect(checkPreventStop).toHaveBeenCalledTimes(1);
    expect(result).toBe(AgentState.PROMPT);
    expect(triologue.note).not.toHaveBeenCalledWith('SYSTEM', expect.stringContaining('Stop prevented'));
  });
});
