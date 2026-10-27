/**
 * hook-recap-contract.test.ts — the LIVE recap contract, driven through handleHook.
 *
 * WHY THIS FILE EXISTS (review M5 of commit b52ff0c): the tool's ARGUMENT surface
 * — the two required fields, the discard request, the length floor, the size
 * gate, the unknown-anchor refusal and the ESC refusal — had NO test that
 * reaches production code. `recap-rewind-empty-summary.test.ts` looked like one,
 * but it drives `handleRecap`, which nothing calls, and its 5th positional
 * argument silently became `lastUserQuery` in the b52ff0c rename. Every
 * assertion there stayed green through the exact regressions below.
 *
 * Each `it` is anchored to one branch of `handleRecapCall` (states/hook.ts) and
 * is written to FAIL if that branch is reverted:
 *
 *   - `target_brief is required`      ← the no-default rule (never fold blind)
 *   - `summary is required`           ← a missing field is malformed, not discard
 *   - `summary: ''`                   ← the ONLY abandon trigger (raw empty)
 *   - `summary: '   '`                ← M2: whitespace must NOT discard the span
 *   - the length floor boundary       ← MIN_RECAP_SUMMARY_CHARS ± 1
 *   - the size pre-check              ← an over-size note loses the span
 *   - the unknown-anchor refusal      ← names a hash that actually works
 *   - `escCancelled`                  ← M1: ESC refuses the rewind
 *
 * Harness: the same mocks as hook-esc-recap.test.ts (agent-io / loader /
 * hook-preprocessor / recap-rewind / mindmap-patch / triologue), so only
 * `handleRecapCall`'s own logic is exercised.
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
      brief: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      verbose: vi.fn(),
    },
  };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => [{ function: { name: 'bash' } }]) },
}));

vi.mock('../../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls: unknown[]) => calls),
}));

// The floor is re-exported by this module, so the test reads the REAL value
// instead of hard-coding 40 and drifting from what production refuses.
vi.mock('../../../loop/recap-rewind.js', async () => {
  const actual = await vi.importActual<typeof import('../../../loop/recap-rewind.js')>(
    '../../../loop/recap-rewind.js',
  );
  return {
    validateRecapIsolation: vi.fn(() => ({ valid: true })),
    MIN_RECAP_SUMMARY_CHARS: actual.MIN_RECAP_SUMMARY_CHARS,
    handleRecapSpan: vi.fn(),
  };
});

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
    getMessages = vi.fn(() => [{ role: 'user', content: 'msg1' }]);
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
    targetRefusal = vi.fn(() => null);
    // foldableOnly=true is the set a refusal may quote; the plain call lists all.
    listBriefHashes = vi.fn((foldableOnly?: boolean) =>
      foldableOnly === false
        ? [
            { hash: 'a1b2c3d4', message: 'explored the parser' },
            { hash: 'deadbeef', message: 'fresh' },
          ]
        : [{ hash: 'a1b2c3d4', message: 'explored the parser' }],
    );
    rewindToLastBrief = vi.fn(() => ({
      anchorMessage: 'explored the parser',
      tokensBefore: 100,
      tokensAfter: 10,
    }));
    getTokenCount = vi.fn(() => 100);
    getResultThreshold = vi.fn(() => 25000);
    recapNoteSize = vi.fn(() => 100);
    skipPendingTools = vi.fn();
  }
  return { Triologue: TriologueStub };
});

// --- Imports after mocks -----------------------------------------------------

import { handleHook } from '../../../loop/states/hook.js';
import { AgentState } from '../../../loop/state-machine.js';
import { handleRecapSpan } from '../../../loop/recap-rewind.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

/**
 * The floor, read from the module that OWNS it.
 *
 * NOT the re-export on `recap-rewind.js`: this file `vi.mock`s that module, so the
 * re-export arrives as `undefined` and a `new RegExp('under undefined …')`
 * assertion would pass while testing nothing.
 */
const { MIN_RECAP_SUMMARY_CHARS: FLOOR } = await vi.importActual<
  typeof import('../../../loop/states/hook.js')
>('../../../loop/states/hook.js');

/** A summary that exactly meets the floor. */
const OK_SUMMARY = 'a'.repeat(FLOOR);

/** The recap tool-result the hook registered for `call.id`. */
function recapResult(triologue: Triologue, callId: string): string {
  const call = vi.mocked(triologue.tool).mock.calls.find(
    ([name, , id]) => name === 'recap' && id === callId,
  );
  return call ? String(call[1]) : '';
}

describe('handleHook — recap contract (the live two-field surface)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  /** Build an env + call whose hookResult carries `args` as a single recap call. */
  function makeEnv(args: Record<string, unknown>) {
    const recapCall = createMockAugmentedToolCall('recap', args);
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [recapCall] }),
    ) as never;
    return { env, recapCall };
  }

  it('refuses a missing target_brief and collapses nothing', async () => {
    const { env, recapCall } = makeEnv({ summary: OK_SUMMARY });
    const result = await handleHook(env, createTurnVars(), createChatData({}));

    expect(recapResult(triologue, recapCall.id)).toMatch(/target_brief is required/);
    // The no-default rule: folding somewhere the model did not choose would
    // delete a span it meant to keep.
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
    expect(result).not.toBe(AgentState.STOP);
  });

  it('refuses a missing summary field (malformed, NOT a discard)', async () => {
    const { env, recapCall } = makeEnv({ target_brief: 'a1b2c3d4' });
    await handleHook(env, createTurnVars(), createChatData({}));

    expect(recapResult(triologue, recapCall.id)).toMatch(/summary is required/);
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
  });

  it('summary: "" is the explicit discard — the abandon note is written and the span folds', async () => {
    const { env } = makeEnv({ target_brief: 'a1b2c3d4', summary: '' });
    await handleHook(env, createTurnVars(), createChatData({}));

    expect(triologue.rewindToLastBrief).toHaveBeenCalledTimes(1);
    const call = vi.mocked(triologue.rewindToLastBrief).mock.calls[0];
    // Args: (additionalMessage, expectedBriefCallId, target, openTodos)
    expect(String(call.at(0))).toMatch(/discarded without being summarized/i);
  });

  it('M2: a WHITESPACE-only summary is refused, not treated as the discard request', async () => {
    // A one-shot value: `clearAllMocks` erases implementations, and this case must
    // never reach the fork — the floor refuses before it (a 500 would be the bug).
    vi.mocked(handleRecapSpan).mockResolvedValueOnce({
      patch: null,
      patchError: null,
      escCancelled: false,
    } as never);

    const { env, recapCall } = makeEnv({ target_brief: 'a1b2c3d4', summary: '   \n\t ' });
    await handleHook(env, createTurnVars(), createChatData({}));

    // BEFORE: `summaryText.length === 0` after trimming made '   ' an abandon and
    // DELETED the span the model meant to summarize.
    const result = recapResult(triologue, recapCall.id);
    expect(result).not.toMatch(/discarded without being summarized/i);
    expect(result).toMatch(/under \d+ characters/);
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
  });

  it('applies the length floor at its BOUNDARY (floor-1 refused, floor accepted)', async () => {
    // `mockResolvedValue` covers BOTH invocations below; a one-shot value would
    // leave the second call's `patch` undefined.
    vi.mocked(handleRecapSpan).mockResolvedValue({
      patch: null,
      patchError: null,
      escCancelled: false,
    } as never);

    const short = makeEnv({ target_brief: 'a1b2c3d4', summary: 'a'.repeat(FLOOR - 1) });
    await handleHook(short.env, createTurnVars(), createChatData({}));
    expect(recapResult(triologue, short.recapCall.id)).toMatch(
      new RegExp(`under ${FLOOR} characters`),
    );
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();

    const exact = makeEnv({ target_brief: 'a1b2c3d4', summary: OK_SUMMARY });
    await handleHook(exact.env, createTurnVars(), createChatData({}));
    expect(triologue.rewindToLastBrief).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-size note BEFORE touching the transcript', async () => {
    vi.mocked(handleRecapSpan).mockResolvedValueOnce({
      patch: null,
      patchError: null,
      escCancelled: false,
    } as never);
    // Size the note one char over the limit the triologue reports.
    vi.mocked(triologue.recapNoteSize).mockReturnValueOnce(25001);

    const { env, recapCall } = makeEnv({ target_brief: 'a1b2c3d4', summary: OK_SUMMARY });
    await handleHook(env, createTurnVars(), createChatData({}));

    // The rewrite happens AFTER the truncation, so an over-size note would lose
    // the span with nothing written back.
    expect(recapResult(triologue, recapCall.id)).toMatch(/over the 25000-char tool-result limit/);
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
  });

  it('an unknown target_brief names the anchors that DO work and never says "without target"', async () => {
    vi.mocked(triologue.getLastBrief).mockReturnValueOnce(undefined as never);
    vi.mocked(triologue.targetRefusal).mockReturnValueOnce('unknown' as never);

    const { env, recapCall } = makeEnv({ target_brief: 'nope1234', summary: OK_SUMMARY });
    await handleHook(env, createTurnVars(), createChatData({}));

    const result = recapResult(triologue, recapCall.id);
    // `target_brief` is never defaulted, so the old "call recap without target"
    // advice pointed at a call that is now REFUSED — an unbreakable retry loop.
    expect(result).not.toMatch(/without target/i);
    expect(result).toContain('[a1b2c3d4]');
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
  });

  it('M1: escCancelled from the patch fork refuses the rewind and stops the turn', async () => {
    vi.mocked(handleRecapSpan).mockResolvedValueOnce({
      patch: null,
      patchError: 'mindmap-patch fork aborted',
      escCancelled: true,
    } as never);

    // Real prose with no [RECAP] prefix, so `hasUsableSummary` is not what refuses it.
    const prose = 'Folded the parser work; the fix lands in parser.ts next.';
    const { env, recapCall } = makeEnv({ target_brief: 'a1b2c3d4', summary: prose });
    const result = await handleHook(env, createTurnVars(), createChatData({}));

    // BEFORE: the guard keyed on `patchError === 'aborted' && neglected`, which the
    // sentinel path never set — the span was truncated after the user asked to stop.
    expect(triologue.rewindToLastBrief).not.toHaveBeenCalled();
    expect(recapResult(triologue, recapCall.id)).toMatch(/Cancelled/);
    expect(result).toBe(AgentState.STOP);
  });
});
