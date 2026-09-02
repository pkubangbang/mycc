/**
 * Tests for state-machine.ts - Agent state machine types and runner
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentStateMachine, AgentState, presentResult } from '../../loop/state-machine.js';
import { setResultCallback } from '../../utils/letter-box.js';
import type { TurnVars, ChatData, StateHandler } from '../../loop/state-machine.js';
import type { Triologue } from '../../loop/triologue.js';
import type { AgentContext, ToolScope } from '../../types.js';
import type { ConditionRegistry } from '../../hook/conditions.js';
import type { Sequence } from '../../hook/sequence.js';
import type { HookExecutor } from '../../hook/hook-executor.js';
import type { InputProvider } from '../../loop/input-provider.js';
import type { RequestEmbeddingTracker } from '../../loop/request-embedding.js';

// ============================================================================
// AgentState enum
// ============================================================================

describe('AgentState', () => {
  it('should have all 8 states', () => {
    expect(AgentState.PROMPT).toBe('prompt');
    expect(AgentState.SLASH).toBe('slash');
    expect(AgentState.COLLECT).toBe('collect');
    expect(AgentState.LLM).toBe('llm');
    expect(AgentState.HOOK).toBe('hook');
    expect(AgentState.TOOL).toBe('tool');
    expect(AgentState.STOP).toBe('stop');
    expect(AgentState.WAIT).toBe('wait');
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
      getCheckpointManager: vi.fn(() => ({
        findOpen: vi.fn(() => null),
        findById: vi.fn(() => null),
        findAll: vi.fn(() => []),
        generateId: vi.fn(() => 'deadbeef'),
        recap: vi.fn(),
      })),
      getWiki: vi.fn(() => undefined),
    } as unknown as Triologue;

    const ctx = {
      core: {
        getConfusionIndex: vi.fn(() => 0),
        resetConfusionIndex: vi.fn(),
        increaseConfusionIndex: vi.fn(),
        getMode: vi.fn(() => 'normal'),
        getAuto: vi.fn(() => false),
        setAuto: vi.fn(),
        brief: vi.fn(),
        verbose: vi.fn(),
        escAware: vi.fn((fn: any) => fn(new AbortController())),
      },
      todo: {
        hasOpenTodo: vi.fn(() => false),
        printTodoList: vi.fn(() => ''),
        closeCheckpointTodo: vi.fn(),
      },
      mail: { collectMails: vi.fn(() => []), clearUnread: vi.fn() },
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

    const requestEmbeddingTracker = {
      addEntry: vi.fn(),
      getMaxSimilarity: vi.fn(() => 0),
      similarityToDelta: vi.fn(() => 0),
      getDuplicationReport: vi.fn(() => ''),
      clear: vi.fn(),
    } as unknown as RequestEmbeddingTracker;

    return { triologue, ctx, conditions, sequence, hookExecutor, inputProvider, requestEmbeddingTracker };
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
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    expect(machine).toBeInstanceOf(AgentStateMachine);
  });

  it('should start in PROMPT state and transition through states', async () => {
    const deps = createMockDeps();
    let callCount = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, _turn, _chat) => {
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
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
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
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    await machine.run();

    expect(handlers[AgentState.PROMPT]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.COLLECT]).not.toHaveBeenCalled();
  });

  it('should reset TurnVars when entering PROMPT from STOP', async () => {
    const deps = createMockDeps();
    const turnVarsHistory: TurnVars[] = [];

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, turn, _chat) => {
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
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
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
      [AgentState.PROMPT]: vi.fn(async (_env, turn, _chat) => {
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
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    await machine.run();

    // Both PROMPT calls should have isFirstRound=true (TurnVars preserved from SLASH)
    expect(turnVarsHistory[0].isFirstRound).toBe(true);
    expect(turnVarsHistory[1].isFirstRound).toBe(true);
  });

  it('should reset ChatData on each COLLECT entry', async () => {
    const deps = createMockDeps();
    const chatHistory: ChatData[] = [];

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => AgentState.COLLECT),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async (_env, _turn, chat) => {
        chatHistory.push({ ...chat });
        if (chatHistory.length < 2) return AgentState.LLM;
        return null; // Exit after second COLLECT
      }),
      [AgentState.LLM]: vi.fn(async () => AgentState.COLLECT), // Go back to COLLECT
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    await machine.run();

    // Each COLLECT should have fresh ChatData
    expect(chatHistory.length).toBe(2);
    for (const chat of chatHistory) {
      expect(chat.abortController).toBeNull();
      expect(chat.rawToolCalls).toEqual([]);
      expect(chat.assistantContent).toBe('');
      expect(chat.augmentedCalls).toEqual([]);
      expect(chat.hookResult).toBeNull();
    }
  });

  it('should preserve deferredCompact across the COLLECT reset (hook-deferred compact reaches the LLM stage)', async () => {
    // Regression for agent-loop-state-machine (dir-1) PR-F test gap 1.
    // HOOK may set chat.deferredCompact = true (e.g. compact-on-intent-trap)
    // and return COLLECT so the LLM stage can run the compact where the tool
    // list is in scope. The COLLECT entry resets ChatData — but it MUST
    // preserve deferredCompact, otherwise the flag is wiped before the LLM
    // stage ever sees it and the deferred-compact branch (llm.ts:63) goes
    // dead. 6b61410 fixed state-machine.ts:203 to carry
    // `deferredCompact: chat.deferredCompact` across the reset; this test
    // locks that so a future regression that hardcodes `deferredCompact:
    // false` in the reset goes red.
    //
    // Flow under test: PROMPT → COLLECT → LLM → HOOK (set flag, → COLLECT)
    //   → COLLECT (assert deferredCompact survived the reset) → LLM (assert
    //   the deferred-compact branch consumed + cleared it) → STOP → PROMPT
    //   (exit).
    const deps = createMockDeps();
    const collectChatSnapshots: boolean[] = [];
    let llmSawDeferred: boolean | null = null;
    let llmClearedDeferred: boolean | null = null;
    let hookPass = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, _turn, _chat) => AgentState.COLLECT),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async (_env, _turn, chat) => {
        // Snapshot whether the flag survived the COLLECT reset.
        collectChatSnapshots.push(chat.deferredCompact);
        return AgentState.LLM;
      }),
      [AgentState.LLM]: vi.fn(async (_env, _turn, chat) => {
        // The LLM stage is the consumer: it reads chat.deferredCompact to
        // decide whether to compact, then clears it (llm.ts:63/72). On the
        // first LLM pass the flag is false (no HOOK has run yet); on the
        // second pass (after HOOK set it) it must be true, and we clear it
        // to mirror the real consumer.
        llmSawDeferred = chat.deferredCompact;
        if (chat.deferredCompact) {
          // Mirror llm.ts:72 — the consumer clears the flag after compacting.
          chat.deferredCompact = false;
          llmClearedDeferred = chat.deferredCompact;
        }
        return AgentState.HOOK;
      }),
      [AgentState.HOOK]: vi.fn(async (_env, _turn, chat) => {
        hookPass++;
        if (hookPass === 1) {
          // First HOOK pass: request a deferred compact and bounce back to
          // COLLECT (the real compact-on-intent-trap path).
          chat.deferredCompact = true;
          return AgentState.COLLECT;
        }
        // Second HOOK pass (after the LLM consumed it): go to STOP. Driven
        // by the pass counter, NOT a flag re-check, so the flow is
        // deterministic and cannot re-enter the set-flag branch forever.
        return AgentState.STOP;
      }),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(async () => AgentState.PROMPT),
      [AgentState.WAIT]: vi.fn(),
    };

    // Make PROMPT exit on its second entry (after STOP → PROMPT).
    let promptCount = 0;
    handlers[AgentState.PROMPT] = vi.fn(async () => {
      promptCount++;
      return promptCount === 1 ? AgentState.COLLECT : null;
    });

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    await machine.run();

    // COLLECT was entered twice: first with deferredCompact=false (fresh
    // pass), second with deferredCompact=true — the flag set by HOOK must
    // have survived the COLLECT reset. This is the core regression guard.
    expect(collectChatSnapshots).toEqual([false, true]);
    // The LLM stage saw the deferred flag on the second pass (proving the
    // preserved flag reached the consumer) and cleared it (mirroring
    // llm.ts:72).
    expect(llmSawDeferred).toBe(true);
    expect(llmClearedDeferred).toBe(false);
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
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    await expect(machine.run()).rejects.toThrow('Handler error');
  });

  it('should pass env, turn, and chat to handlers', async () => {
    const deps = createMockDeps();

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (env, turn, chat) => {
        // env carries the exact injected dependencies
        expect(env.triologue).toBe(deps.triologue);
        expect(env.ctx).toBe(deps.ctx);
        expect(env.scope).toBe('main');
        expect(env.conditions).toBe(deps.conditions);
        expect(env.sequence).toBe(deps.sequence);
        expect(env.hookExecutor).toBe(deps.hookExecutor);
        expect(env.inputProvider).toBe(deps.inputProvider);
        expect(env.sessionFilePath).toBe('/tmp/session.json');
        expect(env.pendingSlashQuery).toBeNull();
        expect(env.crossroadOccurred).toBe(false);
        expect(env.requestEmbeddingTracker).toBe(deps.requestEmbeddingTracker);
        // turn starts fresh
        expect(turn.isFirstRound).toBe(true);
        expect(turn.nextTodoNudge).toBe(3);
        expect(turn.nextBriefNudge).toBe(5);
        expect(turn.lastTodoState).toBe('');
        expect(turn.lastUserQuery).toBe('');
        expect(turn.extractedKeywords).toEqual([]);
        // chat starts fresh
        expect(chat.abortController).toBeNull();
        expect(chat.rawToolCalls).toEqual([]);
        expect(chat.assistantContent).toBe('');
        expect(chat.augmentedCalls).toEqual([]);
        expect(chat.hookResult).toBeNull();
        expect(chat.deferredCompact).toBe(false);
        return null;
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(),
      [AgentState.LLM]: vi.fn(),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
      [AgentState.WAIT]: vi.fn(),
    };

    const machine = new AgentStateMachine(
      deps.triologue, deps.ctx, 'main' as ToolScope,
      deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
      '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
    );

    await machine.run();
  });
});

// ============================================================================
// presentResult
// ============================================================================

describe('presentResult', () => {
  let displayed: string | null;

  beforeEach(() => {
    displayed = null;
    setResultCallback((content: string) => { displayed = content; });
  });

  afterEach(() => {
    setResultCallback(null);
  });

  it('should not throw when triologue has no messages', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => []),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
    // No last message → nothing displayed.
    expect(displayed).toBeNull();
  });

  it('should not throw when last message has no content', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => [{ role: 'assistant', content: '' }]),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
    // Empty content → nothing meaningful displayed.
    expect(displayed).toBeNull();
  });

  it('should display the last message content via the result callback', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => [{ role: 'assistant', content: 'Hello' }]),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
    // The content is mirrored to the result callback (stripped of markup).
    expect(displayed).toBe('Hello');
  });

  it('should display the last message even when it is a tool message', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => [
        { role: 'assistant', content: 'thinking' },
        { role: 'tool', tool_name: 'bash', content: 'tool output', tool_call_id: 'c1' },
      ]),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
    // presentResult uses the LAST message regardless of role.
    expect(displayed).toBe('tool output');
  });

  it('should strip internal DSML markup before display', () => {
    const triologue = {
      getMessagesRaw: vi.fn(() => [{
        role: 'assistant',
        content: 'before <\uff5c\uff5cDSML\uff5c\uff5ctag>hidden</\uff5c\uff5cDSML\uff5c\uff5ctag> after',
      }]),
    } as unknown as Triologue;

    expect(() => presentResult(triologue)).not.toThrow();
    // The DSML tag and its content are stripped; surrounding text remains.
    expect(displayed).toBe('before  after');
  });
});
