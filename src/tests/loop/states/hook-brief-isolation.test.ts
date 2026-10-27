/**
 * hook-brief-isolation.test.ts — handleHook: brief must be called alone.
 *
 * `brief` is recap's rewind anchor, so a brief-only assistant turn keeps the
 * anchor unambiguous (currentAnchorIndex / rewindToLastBrief). The guard is
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

vi.mock('../../../loop/recap-rewind.js', () => ({
  validateRecapIsolation: vi.fn(() => ({ valid: true })),
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
    rewindToLastBrief = vi.fn();
    // Auto-recap (step 4a) asks the stack for foldable spans. EMPTY = no span to
    // fold, which is the state a single brief turn is in anyway.
    getFoldCandidates = vi.fn(() => []);
    getLastBrief = vi.fn(() => undefined);
    getTokenCount = vi.fn(() => 0);
    getTokenThreshold = vi.fn(() => 50000);
    recapNoteSize = vi.fn(() => 0);
    getResultThreshold = vi.fn(() => 50000);
    submitUser = vi.fn();
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
