/**
 * tool-esc.test.ts — handleTool: ESC before / between / during tool execution.
 *
 * Code paths under test (tool.ts):
 *
 *  [A] ESC at entry — checked at the TOP of the for-loop, before every call:
 *      if (agentIO.isNeglectedMode()) {
 *        agentIO.setNeglectedMode(false);
 *        triologue.skipPendingTools('Tool use interrupted - user pressed ESC.',
 *                                   'Tool use skipped due to ESC interruption.');
 *        return AgentState.PROMPT;
 *      }
 *
 *  [B] ESC during tool execution — escAware cleanup returns a string:
 *      const output = await ctx.core.escAware(
 *        async (abortController) => loader.execute(...),
 *        () => 'Tool interrupted by user.'
 *      );
 *      The interrupted output is then registered via triologue.tool() and the
 *      loop continues to the NEXT iteration — where the entry ESC-check fires
 *      again (if neglected mode is still set) and returns PROMPT.
 *
 *  [C] Hook-blocked call — skip execution, register rejection, continue:
 *      if (hookResult.blockedCalls.has(toolCallId)) {
 *        triologue.tool(toolName, blockedCalls.get(toolCallId)!, toolCallId);
 *        continue;
 *      }
 *
 *  [D] Normal execution — loader.execute runs, result registered, loop ends
 *      and returns AgentState.COLLECT.
 *
 *  [E] No hookResult — early return COLLECT (guard at top).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (paths relative to this test file: src/tests/loop/states/) --------

vi.mock('../../../loop/agent-io.js', () => {
  let neglected = false;
  return {
    agentIO: {
      isNeglectedMode: vi.fn(() => neglected),
      setNeglectedMode: vi.fn((v: boolean) => { neglected = v; }),
      verbose: vi.fn(),
    },
  };
});

vi.mock('../../../context/shared/loader.js', () => ({
  loader: { execute: vi.fn() },
}));

vi.mock('../../../config.js', () => ({ isVerbose: vi.fn(() => false) }));

// Minimal Triologue stub — tool.ts needs triologue.tool/skipPendingTools/etc.
vi.mock('../../../loop/triologue.js', () => {
  class TriologueStub {
    tool = vi.fn();
    skipPendingTools = vi.fn();
    needsCompact = vi.fn(() => false);
    compact = vi.fn(async () => {});
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
import { handleTool } from '../../../loop/states/tool.js';
import { AgentState } from '../../../loop/state-machine.js';
import { agentIO } from '../../../loop/agent-io.js';
import { loader } from '../../../context/shared/loader.js';
import { Triologue } from '../../../loop/triologue.js';
import {
  createTurnVars,
  createPassData,
  createMockMachineEnv,
  createMockAugmentedToolCall,
  createMockHookResult,
} from '../esc-test-helpers.js';

describe('handleTool — ESC handling before / between / during tool execution', () => {
  let triologue: Triologue;

  beforeEach(() => {
    vi.clearAllMocks();
    agentIO.setNeglectedMode(false);
    triologue = new Triologue();
  });

  // [E] No hookResult → COLLECT guard
  it('should return COLLECT immediately when hookResult is null', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData({ hookResult: null });

    const result = await handleTool(env, turn, pass);

    expect(result).toBe(AgentState.COLLECT);
  });

  // [A] ESC at entry — before any tool runs
  it('should skip all tools, clear neglected mode, and return PROMPT when ESC at entry', async () => {
    const env = createMockMachineEnv({ triologue });
    const turn = createTurnVars();
    const pass = createPassData({
      hookResult: createMockHookResult({
        calls: [createMockAugmentedToolCall('bash', { command: 'ls' })],
      }),
    });

    // Simulate ESC already pressed before entering handleTool
    agentIO.setNeglectedMode(true);

    const result = await handleTool(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // Neglected mode cleared before returning to PROMPT
    expect(agentIO.isNeglectedMode()).toBe(false);
    // skipPendingTools called to maintain triologue parity
    expect(triologue.skipPendingTools).toHaveBeenCalledTimes(1);
    // No tool was executed
    expect(loader.execute).not.toHaveBeenCalled();
  });

  // [B] ESC during tool execution — escAware cleanup fires, then the NEXT
  //     iteration's entry-check sees neglected mode and returns PROMPT.
  //     Requires at least 2 calls so the loop iterates again after the ESC.
  it('should register interrupted output, then return PROMPT on next iteration when ESC fires mid-tool', async () => {
    const env = createMockMachineEnv({ triologue });
    // escAware cleanup returns the interrupted-string; we also flip neglected
    // mode to true so the NEXT loop iteration's entry-check returns PROMPT.
    env.ctx.core.escAware = vi.fn(async (_operation: any, cleanup: any) => {
      agentIO.setNeglectedMode(true); // ESC sets neglected mode
      return cleanup(new AbortController()); // returns 'Tool interrupted by user.'
    }) as never;

    const call1 = createMockAugmentedToolCall('bash', { command: 'ls' });
    const call2 = createMockAugmentedToolCall('read_file', { path: 'b.ts' });
    const turn = createTurnVars();
    const pass = createPassData({
      hookResult: createMockHookResult({ calls: [call1, call2] }),
    });

    const result = await handleTool(env, turn, pass);

    expect(result).toBe(AgentState.PROMPT);
    // The interrupted output WAS registered as a tool result (triologue.tool)
    expect(triologue.tool).toHaveBeenCalledWith('bash', 'Tool interrupted by user.', call1.id);
    // skipPendingTools fires on the next iteration (call2 skipped)
    expect(triologue.skipPendingTools).toHaveBeenCalledTimes(1);
    // call2 was never executed
    expect(loader.execute).not.toHaveBeenCalled();
  });

  // [C] Hook-blocked call — skip execution, register rejection, continue, end COLLECT
  it('should register blocked message and return COLLECT without executing the tool', async () => {
    const env = createMockMachineEnv({ triologue });
    const blockedMsg = 'blocked by safety hook';
    const call = createMockAugmentedToolCall('bash', { command: 'rm -rf /' });
    const turn = createTurnVars();
    const pass = createPassData({
      hookResult: createMockHookResult({
        calls: [call],
        blockedCalls: new Map([[call.id, blockedMsg]]),
      }),
    });

    const result = await handleTool(env, turn, pass);

    expect(result).toBe(AgentState.COLLECT);
    // The rejection is registered as a tool result (not executed)
    expect(triologue.tool).toHaveBeenCalledWith('bash', blockedMsg, call.id);
    expect(loader.execute).not.toHaveBeenCalled();
  });

  // [D] Normal execution path — one tool, output registered, returns COLLECT
  it('should execute the tool, register the result, and return COLLECT on normal path', async () => {
    const env = createMockMachineEnv({ triologue });
    // escAware runs the operation normally
    env.ctx.core.escAware = vi.fn(async (operation: any) => {
      return await operation(new AbortController());
    }) as never;

    const call = createMockAugmentedToolCall('read_file', { path: 'a.ts' });
    const turn = createTurnVars();
    const pass = createPassData({
      hookResult: createMockHookResult({ calls: [call] }),
    });

    vi.mocked(loader.execute).mockResolvedValueOnce('file contents here');

    const result = await handleTool(env, turn, pass);

    expect(result).toBe(AgentState.COLLECT);
    expect(loader.execute).toHaveBeenCalledTimes(1);
    // Result registered with triologue.tool
    expect(triologue.tool).toHaveBeenCalledWith('read_file', 'file contents here', call.id);
    // No ESC → no skipPendingTools
    expect(triologue.skipPendingTools).not.toHaveBeenCalled();
  });
});