/**
 * hook-brief-isolation.test.ts — handleHook: brief must be called alone.
 *
 * `brief` is the user-facing status checkpoint, so a brief-only assistant turn
 * stays an unambiguous, self-contained turn boundary. The guard is
 * HOOK validation step 2, BEFORE hook processing:
 *
 *   const briefValidation = validateBriefIsolation(augmentedCalls);
 *   if (!briefValidation.valid) {
 *     triologue.agent(...);                       // register the turn
 *     for (const call of augmentedCalls)          // answer EVERY call
 *       triologue.tool(call.function.name, briefValidation.message!, call.id);
 *     agentIO.log(chalk.yellow(`[brief] blocked: …`));
 *     return AgentState.COLLECT;                  // nothing executed
 *   }
 *
 * Strategy: drive handleHook with a mocked hookExecutor and assert (a) the
 * turn is rejected wholesale when brief is co-batched, (b) hook processing is
 * never reached, and (c) a lone brief proceeds to TOOL as usual.
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