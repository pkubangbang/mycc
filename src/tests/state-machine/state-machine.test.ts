/**
 * Tests for state-machine.ts - Agent state machine types and runner
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentStateMachine, AgentState, presentResult } from '../../loop/state-machine.js';
import type { MachineEnv, TurnVars, PassData, StateHandler } from '../../loop/state-machine.js';
import type { Triologue } from '../../loop/triologue.js';
import type { AgentContext, ToolScope } from '../../types.js';
import type { ConditionRegistry } from '../../hook/conditions.js';
import type { Sequence } from '../../hook/sequence.js';
import type { HookExecutor } from '../../hook/hook-executor.js';
import type { InputProvider } from '../../loop/input-provider.js';

// ============================================================================
// AgentState enum
// ============================================================================

describe('AgentState', () => {
  it('should have all 7 states', () => {
    expect(AgentState.PROMPT).toBe('prompt');
    expect(AgentState.SLASH).toBe('slash');
    expect(AgentState.COLLECT).toBe('collect');
    expect(AgentState.LLM).toBe('llm');
    expect(AgentState.HOOK).toBe('hook');
    expect(AgentState.TOOL).toBe('tool');
    expect(AgentState.STOP).toBe('stop');
  });
});

// ============================================================================
// AgentStateMachine
// ============================================================================

describe('AgentStateMachine', () => {
  function createMockDeps() {
    const triologue = {
      getMessagesRaw: vi.fn(() => []),
      getMessages: vi.fn(() => []),
      getLastRole: vi.fn(() => null),
      getLastUserQuery: vi.fn(() => ''),
      getTokenCount: vi.fn(() => 0),
      getTokenThreshold: vi.fn(() => 50000),
      needsCompact: vi.fn(() => false),
      hasActiveWrapUp: vi.fn(() => false),
      findAllCheckpoints: vi.fn(() => []),
      findOpenCheckpoint: vi.fn(() => null),
      findCheckpointById: vi.fn(() => null),
      getMessagesFrom: vi.fn(() => []),
      getWiki: vi.fn(() => undefined),
    } as unknown as Triologue;

    const ctx = {
      core: {
        getConfusionIndex: vi.fn(() => 0),
        resetConfusionIndex: vi.fn(),
        increaseConfusionIndex: vi.fn(),
        getMode: vi.fn(() => 'normal'),
        brief: vi.fn(),
        verbose: vi.fn(),
        escAware: vi.fn((fn: any) => fn(new AbortController())),
      },
      todo: {
        hasOpenTodo: vi.fn(() => false),
        printTodoList: vi.fn(() => ''),
        closeCheckpointTodo: vi.fn(),
      },
      mail: { collectMails: vi.fn(() => []) },
      skill: {
        listSkills: vi.fn(() => []),
        getSkill: vi.fn(),
      },
      team: { handlePendingQuestions: vi.fn() },
    } as unknown as AgentContext;

    const conditions = {
      getPending: vi.fn(() => []),
      load: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      findByTrigger: vi.fn(() => []),
      matches: vi.fn(() => []),
      save: vi.fn(),
      markPending: vi.fn(),
      needsCompilation: vi.fn(() => false),
      markInjected: vi.fn(),
      hasInjected: vi.fn(() => false),
      clearInjected: vi.fn(),
    } as unknown as ConditionRegistry;

    const sequence = {
      add: vi.fn(),
      getEvents: vi.fn(() => []),
      clear: vi.fn(),
      has: vi.fn(() => false),
      hasAny: vi.fn(() => false),
      lastIndexOf: vi.fn(() => -1),
      last: vi.fn(),
      lastError: vi.fn(),
      count: vi.fn(() => 0),
      since: vi.fn(() => []),
      sinceEdit: vi.fn(() => []),
      evaluate: vi.fn(() => false),
      isPlanMode: vi.fn(() => false),
      hasSkillInConversation: vi.fn(() => false),
      totalCount: vi.fn(() => 0),
      markPromptBoundary: vi.fn(),
    } as unknown as Sequence;

    const hookExecutor = {
      processToolCalls: vi.fn(),
    } as unknown as HookExecutor;

    const inputProvider = {
      getInput: vi.fn(),
      setMode: vi.fn(),
    } as unknown as InputProvider;

    return { triologue, ctx, conditions, sequence, hookExecutor, inputProvider };
  }

  it('should construct with env containing all required fields', () => {
    const deps = createMockDeps();
    const handlers = {
      [AgentState.PROMPT]: vi.fn(),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(),
      [AgentState.LLM]: vi.fn(),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    expect(machine).toBeInstanceOf(AgentStateMachine);
  });

  it('should start in PROMPT state and transition through states', async () => {
    const deps = createMockDeps();
    let callCount = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, turn, _pass) => {
        callCount++;
        if (callCount === 1) return AgentState.COLLECT;
        return null; // Exit on second call
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async () => AgentState.LLM),
      [AgentState.LLM]: vi.fn(async () => AgentState.HOOK),
      [AgentState.HOOK]: vi.fn(async () => AgentState.TOOL),
      [AgentState.TOOL]: vi.fn(async () => AgentState.STOP),
      [AgentState.STOP]: vi.fn(async () => AgentState.PROMPT),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await machine.run();

    // PROMPT was called twice (start + after STOP), COLLECT/LLM/HOOK/TOOL/STOP once each
    expect(handlers[AgentState.PROMPT]).toHaveBeenCalledTimes(2);
    expect(handlers[AgentState.COLLECT]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.LLM]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.HOOK]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.TOOL]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.STOP]).toHaveBeenCalledTimes(1);
  });

  it('should exit when PROMPT handler returns null', async () => {
    const deps = createMockDeps();
    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => null),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(),
      [AgentState.LLM]: vi.fn(),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await machine.run();

    expect(handlers[AgentState.PROMPT]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.COLLECT]).not.toHaveBeenCalled();
  });

  it('should reset TurnVars when entering PROMPT from STOP', async () => {
    const deps = createMockDeps();
    const turnVarsHistory: TurnVars[] = [];

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, turn, _pass) => {
        turnVarsHistory.push({ ...turn });
        if (turnVarsHistory.length === 1) return AgentState.COLLECT;
        return null;
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async () => AgentState.LLM),
      [AgentState.LLM]: vi.fn(async () => AgentState.HOOK),
      [AgentState.HOOK]: vi.fn(async () => AgentState.TOOL),
      [AgentState.TOOL]: vi.fn(async () => AgentState.STOP),
      [AgentState.STOP]: vi.fn(async () => AgentState.PROMPT),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await machine.run();

    // First PROMPT call should have fresh TurnVars
    expect(turnVarsHistory[0].isFirstRound).toBe(true);
    expect(turnVarsHistory[0].nextTodoNudge).toBe(3);
    expect(turnVarsHistory[0].nextBriefNudge).toBe(5);
    expect(turnVarsHistory[0].lastTodoState).toBe('');
    expect(turnVarsHistory[0].lastUserQuery).toBe('');
    expect(turnVarsHistory[0].extractedKeywords).toEqual([]);
  });

  it('should preserve TurnVars when entering PROMPT from SLASH', async () => {
    const deps = createMockDeps();
    const turnVarsHistory: TurnVars[] = [];

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, turn, _pass) => {
        turnVarsHistory.push({ ...turn, isFirstRound: turn.isFirstRound });
        if (turnVarsHistory.length === 1) {
          // First call: go to SLASH
          return AgentState.SLASH;
        }
        // Second call: from SLASH, TurnVars should be preserved
        return null;
      }),
      [AgentState.SLASH]: vi.fn(async () => AgentState.PROMPT),
      [AgentState.COLLECT]: vi.fn(),
      [AgentState.LLM]: vi.fn(),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await machine.run();

    // Both PROMPT calls should have isFirstRound=true (TurnVars preserved from SLASH)
    expect(turnVarsHistory[0].isFirstRound).toBe(true);
    expect(turnVarsHistory[1].isFirstRound).toBe(true);
  });

  it('should reset PassData on each COLLECT entry', async () => {
    const deps = createMockDeps();
    const passHistory: PassData[] = [];

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => AgentState.COLLECT),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async (_env, _turn, pass) => {
        passHistory.push({ ...pass });
        if (passHistory.length < 2) return AgentState.LLM;
        return null; // Exit after second COLLECT
      }),
      [AgentState.LLM]: vi.fn(async () => AgentState.COLLECT), // Go back to COLLECT
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await machine.run();

    // Each COLLECT should have fresh PassData
    expect(passHistory.length).toBe(2);
    for (const pass of passHistory) {
      expect(pass.abortController).toBeNull();
      expect(pass.rawToolCalls).toEqual([]);
      expect(pass.assistantContent).toBe('');
      expect(pass.augmentedCalls).toEqual([]);
      expect(pass.hookResult).toBeNull();
    }
  });

  it('should propagate errors from handlers', async () => {
    const deps = createMockDeps();
    const testError = new Error('Handler error');

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => { throw testError; }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(),
      [AgentState.LLM]: vi.fn(),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await expect(machine.run()).rejects.toThrow('Handler error');
  });

  it('should pass env, turn, and pass to handlers', async () => {
    const deps = createMockDeps();

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (env, turn, pass) => {
        expect(env.triologue).toBeDefined();
        expect(env.ctx).toBeDefined();
        expect(env.scope).toBe('main');
        expect(env.conditions).toBeDefined();
        expect(env.sequence).toBeDefined();
        expect(env.hookExecutor).toBeDefined();
        expect(env.inputProvider).toBeDefined();
        expect(env.sessionFilePath).toBe('/tmp/session.json');
        expect(env.pendingSlashQuery).toBeNull();
        expect(turn.isFirstRound).toBe(true);
        expect(pass.rawToolCalls).toEqual([]);
        return null;
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(),
      [AgentState.LLM]: vi.fn(),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers,
    );

    await machine.run();
  });
});

// ============================================================================
// presentResult
// ============================================================================

describe('presentResult', () => {
  it('should not throw when triologue has no messages', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => []),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
  });

  it('should not throw when last message has no content', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => [{ role: 'assistant', content: '' }]),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
  });

  it('should not throw when last message has content', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => [{ role: 'assistant', content: 'Hello' }]),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
  });
});
