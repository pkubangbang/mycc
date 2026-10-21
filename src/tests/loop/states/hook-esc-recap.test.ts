/**
 * hook-esc-recap.test.ts — handleHook: ESC during recap (recap cancellation).
 *
 * Code path under test (hook.ts handleRecapCall):
 *   const { summary, patch } = await handleRecapSpan(fullMessages, span, allTools,
 *                                                    description, mindmap, escAware, comment);
 *   if (summary.startsWith('[RECAP] Cancelled:')) {
 *     triologue.agent(chat.assistantContent, chat.rawToolCalls, ...);
 *     triologue.tool('recap', summary, call.id);
 *     ctx.core.brief('warn', 'recap', summary);
 *     if (agentIO.isNeglectedMode()) {
 *       agentIO.setNeglectedMode(false);
 *       return AgentState.PROMPT;   // ← ESC-during-recap early return
 *     }
 *     turn.isFirstRound = false;
 *     return AgentState.COLLECT;
 *   }
 *
 * Strategy: Mock handleRecap to return '[RECAP] Cancelled: ...' and control
 * agentIO.isNeglectedMode(). Verify the PROMPT-vs-COLLECT branch selection.
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
  validateRecapIsolation: vi.fn(() => ({ valid: true })),
  handleRecap: vi.fn(),
  handleRecapSpan: vi.fn(),
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
      message: 'explored the parser',
      confidence: 7,
      span: [{ role: 'tool', tool_name: 'bash', content: 'ls', tool_call_id: 'x' }],
    }));
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
import { agentIO } from '../../../loop/agent-io.js';
import { handleRecapSpan } from '../../../loop/recap-rewind.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

describe('handleHook — ESC during recap (recap cancellation)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  /**
   * Build a pass + hookResult that routes through handleRecapCall.
   * The hookExecutor.processToolCalls returns a hookResult whose single call
   * is a 'recap' tool call (so the recap dispatch branch fires).
   */
  function makeRecapEnv() {
    const recapCall = createMockAugmentedToolCall('recap', {
      description: 'explored the parser',
      comment: 'Next: implement the fix in parser.ts',
    });
    const env = createMockMachineEnv({ triologue });
    // processToolCalls returns a hookResult containing the recap call
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [recapCall] }),
    ) as never;
    return { env, recapCall };
  }

  it('should return STOP when ESC fires during recap (neglected mode true)', async () => {
    const { env, recapCall } = makeRecapEnv();
    const turn = createTurnVars();
    const chat = createChatData({ assistantContent: 'summarizing now' });

    // handleRecapSpan returns the cancelled summary (ESC during recap LLM call)
    // patch is null because getMindmap() returns null (no mindmap in mock env)
    vi.mocked(handleRecapSpan).mockResolvedValueOnce({
      summary: '[RECAP] Cancelled: ESC pressed during recap.',
      patch: null,
    } as never);
    // ESC set neglected mode
    agentIO.setNeglectedMode(true);

    const result = await handleHook(env, turn, chat);

    // Neglection paths now return STOP; stop.ts handles startWrapUp +
    // setNeglectedMode. hook.ts no longer clears neglected mode itself.
    expect(result).toBe(AgentState.STOP);
    // Neglected mode NOT cleared by hook.ts (stop.ts handles it)
    expect(agentIO.isNeglectedMode()).toBe(true);
    // The cancelled summary registered as the recap tool result
    expect(triologue.tool).toHaveBeenCalledWith(
      'recap',
      '[RECAP] Cancelled: ESC pressed during recap.',
      recapCall.id,
    );
  });

  it('should return COLLECT (not PROMPT) when recap cancelled but neglected mode is false', async () => {
    const { env, recapCall } = makeRecapEnv();
    const turn = createTurnVars();
    const chat = createChatData({ assistantContent: 'summarizing now' });

    vi.mocked(handleRecapSpan).mockResolvedValueOnce({
      summary: '[RECAP] Cancelled: ESC pressed during recap.',
      patch: null,
    } as never);
    // NOT in neglected mode — the cancelled-but-not-neglected path
    agentIO.setNeglectedMode(false);

    const result = await handleHook(env, turn, chat);

    expect(result).toBe(AgentState.COLLECT);
    // summary still registered as the recap tool result
    expect(triologue.tool).toHaveBeenCalledWith(
      'recap',
      '[RECAP] Cancelled: ESC pressed during recap.',
      recapCall.id,
    );
    // turn.isFirstRound flipped to false on the COLLECT branch
    expect(turn.isFirstRound).toBe(false);
  });

  it('should call handleRecapSpan with full messages, span, tools, and escAware wrapper', async () => {
    const { env } = makeRecapEnv();
    const turn = createTurnVars({ lastUserQuery: 'finish the task' });
    const chat = createChatData({ assistantContent: 'let me recap' });

    // Normal (non-cancelled) recap completion — no patch (getMindmap returns null)
    vi.mocked(handleRecapSpan).mockResolvedValueOnce({
      summary: '[RECAP] Summary text here.',
      patch: null,
    } as never);
    // Make getMessages return identifiable content so we can assert it was passed
    const fakeMessages = [{ role: 'user', content: 'msg1' }];
    vi.mocked(triologue.getMessages).mockReturnValue(fakeMessages as never);

    await handleHook(env, turn, chat);

    expect(handleRecapSpan).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(handleRecapSpan).mock.calls[0];
    // fullMessages, span, allTools, description, mindmap, escAware fn, comment, lastUserQuery
    expect(callArgs[0]).toEqual(fakeMessages); // fullMessages
    expect(callArgs[1]).toEqual([{ role: 'tool', tool_name: 'bash', content: 'ls', tool_call_id: 'x' }]); // span
    expect(callArgs[2]).toEqual([{ function: { name: 'bash' } }]); // allTools from loader
    expect(callArgs[3]).toBe('explored the parser'); // description
    expect(typeof callArgs[5]).toBe('function'); // escAware wrapper
    expect(callArgs[7]).toBe('finish the task'); // lastUserQuery
  });
});