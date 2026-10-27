/**
 * hook-esc-and-brief-isolation.test.ts — handleHook's two validation/early-exit
 * guards: (1) `brief` must be called ALONE, and (2) AUTO-RECAP at step 4a may
 * fold an older span, and every failure of the fold means "don't fold".
 *
 * Code path under test (hook.ts handleAutoRecap, step 4a):
 *   await handleAutoRecap(env, turn, chat, hookResult);   // before register
 *     → evaluateRecapSignal(candidates, usage, escAware)  // the OBSERVER
 *     → handleRecapForks({ fullMessages, allTools, mindmap, chunks })
 *     → triologue.rewindToLastBrief(body, anchor.id, hash, openTodos)
 *     → ctx.core.brief('info', 'recap', …) + submitUser(audit, 'steer')
 *
 * The fold is decided OUTSIDE the conversation: the model never sees a target,
 * a hash or a note slot, and a brief turn is the only trigger. Everything below
 * is observable through the stubs: the signal verdict, the forks' result, the
 * rewind call and the audit record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      log: vi.fn(),
      // Step 4a logs the signal verdict on the verbose channel (`agentIO.verbose`).
      verbose: vi.fn(),
      brief: vi.fn(),
    },
  };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

vi.mock('../../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls: unknown[]) => calls),
}));

vi.mock('../../../loop/recap-rewind.js', () => ({
  // The two-fork fold. A fold is now decided OUTSIDE the conversation
  // (recap-signal.ts), so the hook has no recap tool to guard and no
  // model-supplied summary to validate: this module only produces the note.
  handleRecapForks: vi.fn(),
  commitMindmapPatch: vi.fn(() => true),
}));

// The signal is the DECIDER. Stubbed to "skip" by default so the brief path is
// unchanged; the fold cases below opt in by returning a recap verdict.
vi.mock('../../../loop/recap-signal.js', () => ({
  evaluateRecapSignal: vi.fn(async () => ({ status: 'skip', reason: 'test' })),
}));

vi.mock('../../../mindmap/patch.js', () => ({
  applyPatchAction: vi.fn(() => true),
}));

vi.mock('../../../mindmap/patch-jsonl.js', () => ({
  appendPatch: vi.fn(),
  getPatchPath: vi.fn(() => '/tmp/.mycc/mindmap-patch.jsonl'),
}));

vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    agent = vi.fn();
    tool = vi.fn();
    note = vi.fn();
    tool_name = undefined;
    getMessages = vi.fn(() => []);
    getMessagesRaw = vi.fn(() => []);
    getLastRole = vi.fn(() => null);
    setSystemPrompt = vi.fn();
    getLastBrief = vi.fn(() => ({
      hash: 'a1b2c3d4',
      id: 'brief_1',
      message: 'explored the parser',
      confidence: 7,
      span: [{ role: 'tool', tool_name: 'bash', content: 'ls', tool_call_id: 'x' }],
    }));
    rewindToLastBrief = vi.fn(() => ({
      anchorMessage: 'explored the parser',
      tokensBefore: 100,
      tokensAfter: 10,
    }));
    // Step 4a also sizes the note before the rewrite (mock returns 100).
    recapNoteSize = vi.fn(() => 100);
    getTokenCount = vi.fn(() => 100);
    getTokenThreshold = vi.fn(() => 50000);
    getResultThreshold = vi.fn(() => 25000);
    // Auto-recap step 4a: the foldable spans the signal may choose from.
    getFoldCandidates = vi.fn(() => [
      { hash: 'a1b2c3d4', message: 'explored the parser', id: 'brief_1', spanMessages: 1, spanTokens: 20 },
    ]);
    // The audit record of a fold (journal-only; never a store message).
    submitUser = vi.fn();
    skipPendingTools = vi.fn();
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------
import { handleHook } from '../../../loop/states/hook.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { handleRecapForks } from '../../../loop/recap-rewind.js';
import { evaluateRecapSignal } from '../../../loop/recap-signal.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

const ISOLATION_MESSAGE =
  'Brief must be called alone. Other tools cannot be used in the same turn.';

describe('handleHook — brief isolation', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  it('rejects a turn that co-batches brief with another tool', async () => {
    const briefCall = createMockAugmentedToolCall('brief', { message: 'looking', confidence: 6 }, 'call_brief');
    const bashCall = createMockAugmentedToolCall('bash', { command: 'ls' }, 'call_bash');
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [briefCall, bashCall] }),
    ) as never;
    const chat = createChatData({
      assistantContent: 'checking things',
      rawToolCalls: [briefCall, bashCall] as never,
    });

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.COLLECT);
    // The assistant turn is registered once...
    expect(triologue.agent).toHaveBeenCalledTimes(1);
    // ...and EVERY call is answered with the same rejection (no partial run).
    expect(triologue.tool).toHaveBeenCalledTimes(2);
    expect(triologue.tool).toHaveBeenCalledWith('brief', ISOLATION_MESSAGE, 'call_brief');
    expect(triologue.tool).toHaveBeenCalledWith('bash', ISOLATION_MESSAGE, 'call_bash');
    // Hook processing never runs on a rejected turn.
    expect(env.hookExecutor.processToolCalls).not.toHaveBeenCalled();
    // Observability: the yellow block line is logged.
    expect(agentIO.log).toHaveBeenCalledWith(expect.stringContaining('[brief] blocked:'));
  });

  it('lets a lone brief through to TOOL', async () => {
    const briefCall = createMockAugmentedToolCall('brief', { message: 'looking', confidence: 6 }, 'call_brief');
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [briefCall] }),
    ) as never;
    const chat = createChatData({
      assistantContent: 'checking things',
      rawToolCalls: [briefCall] as never,
    });

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.TOOL);
    expect(env.hookExecutor.processToolCalls).toHaveBeenCalledTimes(1);
    expect(triologue.tool).not.toHaveBeenCalled();
    expect(agentIO.log).not.toHaveBeenCalledWith(expect.stringContaining('[brief] blocked:'));
  });

  it('does not disturb turns that do not contain brief', async () => {
    const bashCall = createMockAugmentedToolCall('bash', { command: 'ls' }, 'call_bash');
    const readCall = createMockAugmentedToolCall('read_file', { path: 'x' }, 'call_read');
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [bashCall, readCall] }),
    ) as never;
    const chat = createChatData({
      assistantContent: '',
      rawToolCalls: [bashCall, readCall] as never,
    });

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.TOOL);
    expect(env.hookExecutor.processToolCalls).toHaveBeenCalledTimes(1);
    expect(triologue.tool).not.toHaveBeenCalled();
  });
});

describe('handleHook — auto-recap (fold decided outside the conversation)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  /**
   * A brief turn: the ONLY trigger of a fold. The signal is stubbed per case;
   * the forks are stubbed to report a summary / a cancellation.
   */
  function makeBriefTurnEnv() {
    const briefCall = createMockAugmentedToolCall('brief', { message: 'next step', confidence: 7 }, 'brief_now');
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [briefCall] }),
    ) as never;
    const chat = createChatData({ assistantContent: 'status', rawToolCalls: [briefCall] as never });
    return { env, briefCall, chat };
  }

  it('folds when the signal says so: rewinds, reports, and journals ONE audit record', async () => {
    vi.mocked(evaluateRecapSignal).mockResolvedValueOnce({ status: 'recap', target: 'a1b2c3d4', reason: 'span complete' });
    vi.mocked(handleRecapForks).mockResolvedValueOnce({
      summary: 'The parser was mapped; the fix goes in parser.ts next.',
      summaryError: null,
      patch: null,
      patchError: null,
      escCancelled: false,
    });
    const { env, chat } = makeBriefTurnEnv();
    const turn = createTurnVars({ lastUserQuery: 'finish the task' });

    const result = await handleHook(env, turn, chat);

    // The turn still runs: the fold is an enhancement, never a dependency.
    expect(result).toBe(AgentState.TOOL);
    expect(handleRecapForks).toHaveBeenCalledTimes(1);
    // Rewind with the CAS token + the signal's hash; nothing else touches the store.
    expect(triologue.rewindToLastBrief).toHaveBeenCalledWith(
      expect.stringContaining('The parser was mapped'),
      'brief_1',
      'a1b2c3d4',
      expect.any(String),
    );
    // The audit record is a synthesized 'steer' — journal-only, never a message.
    expect(triologue.submitUser).toHaveBeenCalledWith(
      expect.stringContaining('[RECAP] Folded 1 message(s)'),
      'steer',
    );
    // A fold answers this turn's context: the plan-scope reflection is skipped.
    expect(chat.autoRecapFolded).toBe(true);
    // The in-turn brief memory is resynced to the anchor that survived.
    expect(turn.lastBriefMessage).toBe('explored the parser');
  });

  it('folds NOTHING when the user pressed ESC during the forks', async () => {
    vi.mocked(evaluateRecapSignal).mockResolvedValueOnce({ status: 'recap', target: 'a1b2c3d4', reason: 'span complete' });
    vi.mocked(handleRecapForks).mockResolvedValueOnce({
      summary: null,
      summaryError: 'summary fork aborted',
      patch: null,
      patchError: null,
      escCancelled: true,
    });
    const { env, chat } = makeBriefTurnEnv();

    const result = await handleHook(env, createTurnVars(), chat);

    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
    expect(triologue.submitUser).not.toHaveBeenCalled();
    expect(chat.autoRecapFolded).toBeFalsy();
    // The fold returns void: a cancelled fold is just "don't fold" — the brief
    // turn proceeds to TOOL and the user's ESC is honoured by the layer that
    // already owns it (the current turn was never registered here, so nothing
    // was summarised away).
    expect(result).toBe(AgentState.TOOL);
  });

  it('folds NOTHING when the summary fork fails — the span keeps its detail', async () => {
    vi.mocked(evaluateRecapSignal).mockResolvedValueOnce({ status: 'recap', target: 'a1b2c3d4', reason: 'span complete' });
    vi.mocked(handleRecapForks).mockResolvedValueOnce({
      summary: null,
      summaryError: 'summary fork failed: boom',
      patch: null,
      patchError: null,
      escCancelled: false,
    });
    const { env, chat } = makeBriefTurnEnv();

    await handleHook(env, createTurnVars(), chat);

    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
    expect(triologue.submitUser).not.toHaveBeenCalled();
  });

  it('folds NOTHING and reports the skip when the signal declines', async () => {
    vi.mocked(evaluateRecapSignal).mockResolvedValueOnce({ status: 'skip', reason: 'newer work depends on it' });
    const { env, chat } = makeBriefTurnEnv();

    const result = await handleHook(env, createTurnVars(), chat);

    expect(handleRecapForks).not.toHaveBeenCalled();
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
    expect(chat.autoRecapFolded).toBeFalsy();
    expect(result).toBe(AgentState.TOOL);
  });

  it('folds NOTHING and reports the skip when the signal declines', async () => {
    vi.mocked(evaluateRecapSignal).mockResolvedValueOnce({ status: 'skip', reason: 'newer work depends on it' });
    const { env, chat } = makeBriefTurnEnv();

    const result = await handleHook(env, createTurnVars(), chat);

    expect(handleRecapForks).not.toHaveBeenCalled();
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
    expect(chat.autoRecapFolded).toBeFalsy();
    expect(result).toBe(AgentState.TOOL);
  });

  it('skips the whole fold under --no-recap / MYCC_NO_RECAP=1', async () => {
    const prev = process.env.MYCC_NO_RECAP;
    process.env.MYCC_NO_RECAP = '1';
    try {
      const { env, chat } = makeBriefTurnEnv();

      const result = await handleHook(env, createTurnVars(), chat);

      // The OFF switch is checked BEFORE the observer: no signal call at all.
      expect(evaluateRecapSignal).not.toHaveBeenCalled();
      expect(handleRecapForks).not.toHaveBeenCalled();
      expect(result).toBe(AgentState.TOOL);
    } finally {
      if (prev === undefined) delete process.env.MYCC_NO_RECAP;
      else process.env.MYCC_NO_RECAP = prev;
    }
  });

  it('does not even ask the signal when the turn is not a brief turn', async () => {    const bashCall = createMockAugmentedToolCall('bash', { command: 'ls' }, 'call_bash');
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [bashCall] }),
    ) as never;
    const chat = createChatData({ assistantContent: 'working', rawToolCalls: [bashCall] as never });

    await handleHook(env, createTurnVars(), chat);

    expect(evaluateRecapSignal).not.toHaveBeenCalled();
    expect(handleRecapForks).not.toHaveBeenCalled();
  });

  it('forwards the pre-registration snapshot, the full tool list and the escAware runner', async () => {
    vi.mocked(evaluateRecapSignal).mockResolvedValueOnce({ status: 'recap', target: 'a1b2c3d4', reason: 'span complete' });
    vi.mocked(handleRecapForks).mockResolvedValueOnce({
      summary: 'a summary long enough to fold the span away cleanly',
      summaryError: null,
      patch: null,
      patchError: null,
      escCancelled: false,
    });
    const fakeMessages = [{ role: 'user', content: 'msg1' }];
    vi.mocked(triologue.getMessages).mockReturnValue(fakeMessages as never);
    const { env, chat } = makeBriefTurnEnv();

    await handleHook(env, createTurnVars(), chat);

    const args = vi.mocked(handleRecapForks).mock.calls[0][0];
    // The CACHE INVARIANT: un-minified messages + the COMPLETE tool schema.
    expect(args.fullMessages).toEqual(fakeMessages);
    expect(args.allTools).toEqual([{ function: { name: 'bash' } }]);
    // N = the chunks from the target to the newest foldable span (here: 1).
    expect(args.chunks).toBe(1);
  });
});
