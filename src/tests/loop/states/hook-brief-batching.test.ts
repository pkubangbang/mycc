/**
 * hook-brief-batching.test.ts — handleHook: brief may share a turn with other
 * tool calls.
 *
 * `brief` used to be rejected wholesale when batched ("Brief must be called
 * alone") by HOOK validation step 2 (validateBriefIsolation). That gate was
 * removed: batching is now allowed and only the TOOL stage sees the calls.
 *
 * Strategy: drive handleHook with a mocked hookExecutor and assert (a) a turn
 * that co-batches brief with another tool is processed normally and reaches
 * TOOL, (b) hook processing DOES run, and (c) no `[brief] blocked:` line is
 * ever logged.
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
import { agentIO } from '../../../loop/agent-io.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createChatData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

describe('handleHook — brief batching', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    triologue = new Triologue();
  });

  it('processes a turn that co-batches brief with another tool', async () => {
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

    // The turn proceeds to TOOL — nothing is answered with a rejection.
    expect(result).toBe(AgentState.TOOL);
    expect(triologue.tool).not.toHaveBeenCalled();
    // Hook processing runs exactly as for any other batch.
    expect(env.hookExecutor.processToolCalls).toHaveBeenCalledTimes(1);
    // No rejection line is ever logged for a batched brief.
    expect(agentIO.log).not.toHaveBeenCalledWith(expect.stringContaining('[brief] blocked:'));
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
