/**
 * hook-crossroad-merge.test.ts — handleHook's crossroad branch, as it behaves
 * after the 2026-11-09 review.
 *
 * One property under test: a resolved crossroad is merged ONLY when the user has
 * not cancelled the turn and when the pass is not being swallowed by a deferred
 * compaction. Both guards exist because the merge is committed after an `await`
 * (the hook executor), so ESC and a compact request can both win the race.
 *
 *   - ESC: the user ended the turn; committing the merged assistant message here
 *     would persist a resolved crossroad into a turn they aborted.
 *   - Compact: the early return rebuilds `chat`, so the resolution vanished with
 *     no note and no event — while the record file and the confusion charge had
 *     already happened.
 *
 * MOCK STATE: `vi.mock` factories are hoisted above the imports, so the two
 * agentIO functions read a single `vi.hoisted` object that both the factory and
 * the tests can reach. A second, describe-scoped flag would be shadowed by the
 * factory's copy and every `setNeglectedMode(true)` would be invisible to the
 * code under test — which is exactly the bug this file is here to prevent.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const state = vi.hoisted(() => ({ neglected: false }));

vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: {
    isNeglectedMode: vi.fn(() => state.neglected),
    setNeglectedMode: vi.fn((v: boolean) => {
      state.neglected = v;
    }),
    log: vi.fn(),
    verbose: vi.fn(),
    brief: vi.fn()
  }
}));

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => []) }
}));

vi.mock('../../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls: unknown[]) => calls)
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    agent = vi.fn();
    tool = vi.fn();
    note = vi.fn();
    getLastBrief = vi.fn(() => undefined);
    rewindToLastBrief = vi.fn();
    skipPendingTools = vi.fn();
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleHook } from '../../../loop/states/hook.js';
import { agentIO } from '../../../loop/agent-io.js';
import { AgentState } from '../../../loop/state-machine.js';
import { Triologue } from '../../../loop/triologue.js';
import { createTurnVars, createChatData, createMockMachineEnv, createMockHookResult } from '../esc-test-helpers.js';

/** A chat in the exact state llm.ts leaves when a crossroad resolved. */
function resolvedChat() {
  return createChatData({
    assistantContent: 'The plan is set.',
    crossroadContinuation: 'The cache is the real problem.',
    crossroadCandidates: ['go forward', 'go backward', 'synthesize'],
    crossroadSelectedIndex: 1,
    crossroadCutpoint: 'However,',
    crossroadOriginal: ' the cache is fine.',
    crossroadFilePath: 'C:/session/crossroad-1.json'
  } as never);
}

describe('handleHook — crossroad merge guards', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps the factories' implementations but resets the
    // counter semantics; re-attach through the mock API anyway so each test
    // starts from a live turn no matter what the previous one did.
    vi.mocked(agentIO.isNeglectedMode).mockImplementation(() => state.neglected);
    vi.mocked(agentIO.setNeglectedMode).mockImplementation((v: boolean) => {
      state.neglected = v;
    });
    state.neglected = false;
    triologue = new Triologue();
  });

  /** The crossroad branch reads the mode; the shared stub leaves it undefined. */
  function liveEnv() {
    const env = createMockMachineEnv({ triologue });
    (env.ctx.core as unknown as { getMode: () => string }).getMode = vi.fn(() => 'normal');
    return env;
  }

  it('merges the resolution when the turn is live', async () => {
    const env = liveEnv();
    env.hookExecutor.processToolCalls = vi.fn(async () => createMockHookResult({ calls: [] })) as never;
    const chat = resolvedChat();

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.COLLECT);
    expect(triologue.agent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(triologue.agent).mock.calls[0][0]).toBe('The plan is set. The cache is the real problem.');
    // State cleared after a successful merge.
    expect(chat.crossroadContinuation).toBeUndefined();
  });

  it('does NOT commit the merge when ESC landed during the hook await', async () => {
    const env = liveEnv();
    // The hook executor is a real await — the user can cancel inside it.
    env.hookExecutor.processToolCalls = vi.fn(async () => {
      // ESC arrives during the await: exactly what stop.ts arms on the signal.
      state.neglected = true;
      agentIO.setNeglectedMode(true);
      return createMockHookResult({ calls: [] });
    }) as never;
    const chat = resolvedChat();

    const result = await handleHook(env, createTurnVars(), chat);

    // BEFORE: the branch had no ESC guard, so this registration still happened
    // and the resolved crossroad was persisted into an aborted turn.
    // The GUARDED MERGE must not happen. Falling through to the normal HOOK
    // registration (raw content, original tool calls) is the correct outcome:
    // the turn is cancelled, so the reply goes in unchanged and stop.ts ends it.
    const committed = vi.mocked(triologue.agent).mock.calls.map((c) => c[0]);
    expect(committed).not.toContain('The plan is set. The cache is the real problem.');
    // …and the crossroad state is forgotten, not left for a later pass.
    expect(chat.crossroadContinuation).toBeUndefined();
    // The cancelled turn ENDS here: HOOK's neglected path hands wrap-up to STOP.
    expect(result).toBe(AgentState.STOP);
    expect(chat.crossroadFilePath).toBeUndefined();
    expect(chat.crossroadCutpoint).toBeUndefined();
  });

  it('reports and clears the resolution when a compact wins the same pass', async () => {
    const env = liveEnv();
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [], compactRequested: true })
    ) as never;
    const chat = resolvedChat();

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.COLLECT);
    expect(chat.deferredCompact).toBe(true);
    // BEFORE: the resolution disappeared with the state rebuild — no note, no
    // event — even though its record file had already been written.
    expect(triologue.agent).not.toHaveBeenCalled();
    expect(env.ctx.core.brief).toHaveBeenCalledWith(
      'info',
      'crossroad',
      expect.stringContaining('resolved but not applied')
    );
    expect(chat.crossroadContinuation).toBeUndefined();
  });
});
