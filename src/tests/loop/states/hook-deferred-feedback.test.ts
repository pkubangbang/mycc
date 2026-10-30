/**
 * hook-deferred-feedback.test.ts — handleHook: deferred hook messages.
 *
 * Drives handleHook with a mocked hookExecutor and asserts that messages a
 * hook defers are re-injected as REMINDER notes before the round is abandoned
 * (crossroad branch, no-tool-calls branch), and that the pass-scoped
 * `hookFeedbackDelivered` flag is set so the caller knows a COLLECT loop-back
 * is owed.
 *
 * (The header was copied verbatim from the old brief-isolation suite, whose
 * guard has since been removed — batching a brief with other tools is allowed.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      log: vi.fn(),
      verbose: vi.fn(),
      brief: vi.fn(),
    },
  };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { getToolsForScope: vi.fn(() => []) },
}));

vi.mock('../../../hook/hook-preprocessor.js', () => ({
  augmentToolCalls: vi.fn((calls: unknown[]) => calls),
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
import { AgentState } from '../../../loop/state-machine.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';


const DEFERRED = [{ hookName: 'lint-after-edit', message: 'lint reported 2 errors' }];

describe('handleHook — deferred hook feedback (row lead-002)', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  it('injects each deferred message exactly once and flags the chat', async () => {
    const bashCall = createMockAugmentedToolCall('bash', { command: 'ls' }, 'call_bash');
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [bashCall], deferredMessages: DEFERRED }),
    ) as never;
    const chat = createChatData({ assistantContent: '', rawToolCalls: [bashCall] as never });

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.TOOL);
    expect(triologue.note).toHaveBeenCalledTimes(1);
    expect(triologue.note).toHaveBeenCalledWith(
      'REMINDER',
      'Hook "lint-after-edit" deferred this message: lint reported 2 errors',
      'lint-after-edit',
    );
    expect(chat.hookFeedbackDelivered).toBe(true);
  });

  it('loops back to COLLECT when the round has feedback but runs no tools', async () => {
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [], deferredMessages: DEFERRED }),
    ) as never;
    // An EMPTY tool-call list (not undefined): a no-calls round still carries
    // a registered assistant turn, which is what HOOK then evaluates.
    const chat = createChatData({ assistantContent: '', rawToolCalls: [] as never });

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.COLLECT);
    expect(triologue.note).toHaveBeenCalledTimes(1);
  });

  it('stops normally when the round has neither calls nor feedback', async () => {
    const env = createMockMachineEnv({ triologue });
    env.hookExecutor.processToolCalls = vi.fn(async () =>
      createMockHookResult({ calls: [], deferredMessages: [] }),
    ) as never;
    const chat = createChatData({ assistantContent: 'done', rawToolCalls: [] as never });

    const result = await handleHook(env, createTurnVars(), chat);

    expect(result).toBe(AgentState.STOP);
    expect(triologue.note).not.toHaveBeenCalled();
    expect(chat.hookFeedbackDelivered).toBeUndefined();
  });
});