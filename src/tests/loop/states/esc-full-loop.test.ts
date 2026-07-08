/**
 * esc-full-loop.test.ts — Layer B: full-loop ESC integration.
 *
 * Tests the AgentStateMachine.run() loop driving multiple state handlers,
 * focusing on the ESC quick-return path: when ESC fires mid-LLM, handleLlm
 * returns PROMPT (instead of HOOK), short-circuiting the pipeline and
 * returning control to the user immediately.
 *
 * Code paths exercised (state-machine.ts run()):
 *   - Normal pipeline:  PROMPT → COLLECT → LLM → HOOK → TOOL → STOP → PROMPT → exit
 *   - ESC quick-return:  PROMPT → COLLECT → LLM (ESC) → PROMPT → exit
 *                       (LLM returns PROMPT instead of HOOK → loop jumps back)
 *   - TurnVars reset on PROMPT-from-STOP (but not from SLASH)
 *   - PassData reset on every COLLECT entry
 *   - Exit when PROMPT returns null
 *
 * Strategy: Use mock StateHandler functions (vi.fn) that return scripted states,
 * recording the transition sequence. This mirrors the existing
 * state-machine.test.ts pattern but focuses on ESC-related transitions.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentStateMachine, AgentState } from '../../../loop/state-machine.js';
import type { StateHandler } from '../../../loop/state-machine.js';
import type { Triologue } from '../../../loop/triologue.js';
import type { AgentContext, ToolScope } from '../../../types.js';
import type { ConditionRegistry } from '../../../hook/conditions.js';
import type { Sequence } from '../../../hook/sequence.js';
import type { HookExecutor } from '../../../hook/hook-executor.js';
import type { InputProvider } from '../../../loop/input-provider.js';
import type { RequestEmbeddingTracker } from '../../../loop/request-embedding.js';

// --- Shared mock-deps factory (mirrors state-machine.test.ts) ---------------
function createMockDeps() {
  const triologue = {
    getMessagesRaw: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getLastRole: vi.fn(() => null),
    getTokenCount: vi.fn(() => 0),
    needsCompact: vi.fn(() => false),
    hasActiveWrapUp: vi.fn(() => false),
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
    todo: { hasOpenTodo: vi.fn(() => false), printTodoList: vi.fn(() => ''), closeCheckpointTodo: vi.fn() },
    mail: { collectMails: vi.fn(() => []), clearUnread: vi.fn() },
    skill: { listSkills: vi.fn(() => []), getSkill: vi.fn() },
    team: { handlePendingQuestions: vi.fn() },
  } as unknown as AgentContext;

  const conditions = {
    getPending: vi.fn(() => []), load: vi.fn(), get: vi.fn(), set: vi.fn(),
    findByTrigger: vi.fn(() => []), matches: vi.fn(() => []), save: vi.fn(),
    markPending: vi.fn(), needsCompilation: vi.fn(() => false),
    markInjected: vi.fn(), hasInjected: vi.fn(() => false), clearInjected: vi.fn(),
  } as unknown as ConditionRegistry;

  const sequence = {
    add: vi.fn(), getEvents: vi.fn(() => []), clear: vi.fn(), has: vi.fn(() => false),
    hasAny: vi.fn(() => false), lastIndexOf: vi.fn(() => -1), last: vi.fn(),
    lastError: vi.fn(), count: vi.fn(() => 0), since: vi.fn(() => []),
    sinceEdit: vi.fn(() => []), evaluate: vi.fn(() => false), isPlanMode: vi.fn(() => false),
    hasSkillInConversation: vi.fn(() => false), totalCount: vi.fn(() => 0),
    markPromptBoundary: vi.fn(),
  } as unknown as Sequence;

  const hookExecutor = { processToolCalls: vi.fn() } as unknown as HookExecutor;
  const inputProvider = { getInput: vi.fn(), setMode: vi.fn() } as unknown as InputProvider;
  const requestEmbeddingTracker = {
    addEntry: vi.fn(), getMaxSimilarity: vi.fn(() => 0),
    similarityToDelta: vi.fn(() => 0), getDuplicationReport: vi.fn(() => ''), clear: vi.fn(),
  } as unknown as RequestEmbeddingTracker;

  return { triologue, ctx, conditions, sequence, hookExecutor, inputProvider, requestEmbeddingTracker };
}

function buildMachine(deps: ReturnType<typeof createMockDeps>, handlers: Record<AgentState, StateHandler>) {
  return new AgentStateMachine(
    deps.triologue, deps.ctx, 'main' as ToolScope,
    deps.conditions, deps.sequence, deps.hookExecutor, deps.inputProvider,
    '/tmp/session.json', handlers, deps.requestEmbeddingTracker,
  );
}

describe('AgentStateMachine — full-loop ESC integration', () => {
  // [1] ESC quick-return: LLM returns PROMPT (instead of HOOK) when ESC fires.
  //     The loop should jump straight back to PROMPT, skipping HOOK/TOOL/STOP.
  it('should short-circuit to PROMPT (skipping HOOK/TOOL/STOP) when LLM returns PROMPT on ESC', async () => {
    const deps = createMockDeps();
    const visited: AgentState[] = [];
    let promptCalls = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => {
        promptCalls++;
        visited.push(AgentState.PROMPT);
        return promptCalls === 1 ? AgentState.COLLECT : null; // exit on 2nd
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async () => { visited.push(AgentState.COLLECT); return AgentState.LLM; }),
      // LLM simulates ESC: returns PROMPT (not HOOK) → quick-return
      [AgentState.LLM]: vi.fn(async () => { visited.push(AgentState.LLM); return AgentState.PROMPT; }),
      [AgentState.HOOK]: vi.fn(async () => { visited.push(AgentState.HOOK); return AgentState.TOOL; }),
      [AgentState.TOOL]: vi.fn(async () => { visited.push(AgentState.TOOL); return AgentState.STOP; }),
      [AgentState.STOP]: vi.fn(async () => { visited.push(AgentState.STOP); return AgentState.PROMPT; }),
    };

    await buildMachine(deps, handlers).run();

    // Sequence: PROMPT → COLLECT → LLM → PROMPT (ESC short-circuit) → exit
    expect(visited).toEqual([AgentState.PROMPT, AgentState.COLLECT, AgentState.LLM, AgentState.PROMPT]);
    // HOOK/TOOL/STOP must NOT have been visited (ESC skipped them)
    expect(handlers[AgentState.HOOK]).not.toHaveBeenCalled();
    expect(handlers[AgentState.TOOL]).not.toHaveBeenCalled();
    expect(handlers[AgentState.STOP]).not.toHaveBeenCalled();
  });

  // [2] Normal pipeline completes a full turn then exits on the next PROMPT.
  it('should complete the full pipeline PROMPT→COLLECT→LLM→HOOK→TOOL→STOP→PROMPT then exit', async () => {
    const deps = createMockDeps();
    const visited: AgentState[] = [];
    let promptCalls = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => {
        promptCalls++;
        visited.push(AgentState.PROMPT);
        return promptCalls === 1 ? AgentState.COLLECT : null;
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async () => { visited.push(AgentState.COLLECT); return AgentState.LLM; }),
      [AgentState.LLM]: vi.fn(async () => { visited.push(AgentState.LLM); return AgentState.HOOK; }),
      [AgentState.HOOK]: vi.fn(async () => { visited.push(AgentState.HOOK); return AgentState.TOOL; }),
      [AgentState.TOOL]: vi.fn(async () => { visited.push(AgentState.TOOL); return AgentState.STOP; }),
      [AgentState.STOP]: vi.fn(async () => { visited.push(AgentState.STOP); return AgentState.PROMPT; }),
    };

    await buildMachine(deps, handlers).run();

    expect(visited).toEqual([
      AgentState.PROMPT, AgentState.COLLECT, AgentState.LLM, AgentState.HOOK,
      AgentState.TOOL, AgentState.STOP, AgentState.PROMPT,
    ]);
    // Each non-PROMPT handler exactly once; PROMPT twice (start + after STOP)
    expect(handlers[AgentState.COLLECT]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.LLM]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.HOOK]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.TOOL]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.STOP]).toHaveBeenCalledTimes(1);
    expect(handlers[AgentState.PROMPT]).toHaveBeenCalledTimes(2);
  });

  // [3] TurnVars is reset when re-entering PROMPT from STOP (new conversational turn),
  //     but preserved across the ESC short-circuit (PROMPT-from-LLM also resets since
  //     prevState !== SLASH). The key invariant: ESC quick-return re-shows the prompt
  //     with FRESH TurnVars so the user's next query starts a clean turn.
  it('should reset TurnVars on PROMPT re-entry after the ESC quick-return from LLM', async () => {
    const deps = createMockDeps();
    const promptTurnVars: { isFirstRound: boolean; nextTodoNudge: number }[] = [];
    let promptCalls = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async (_env, turn) => {
        promptCalls++;
        // Mutate turn to detect whether the SAME object is reused (would mean no reset)
        promptTurnVars.push({ isFirstRound: turn.isFirstRound, nextTodoNudge: turn.nextTodoNudge });
        return promptCalls === 1 ? AgentState.COLLECT : null;
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async (_env, turn) => {
        // COLLECT runs in the same turn as the originating PROMPT — flip a field
        // to confirm the post-ESC PROMPT gets a fresh object, not this mutated one.
        turn.nextTodoNudge = 99;
        return AgentState.LLM;
      }),
      [AgentState.LLM]: vi.fn(async () => AgentState.PROMPT), // ESC quick-return
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    await buildMachine(deps, handlers).run();

    // Both PROMPT calls should have the default nextTodoNudge=3 (fresh TurnVars).
    // The COLLECT mutation (99) must NOT leak into the second PROMPT.
    expect(promptTurnVars[0].nextTodoNudge).toBe(3);
    expect(promptTurnVars[1].nextTodoNudge).toBe(3);
    expect(promptTurnVars[1].isFirstRound).toBe(true);
  });

  // [4] PassData is reset on every COLLECT entry — including after the ESC
  //     short-circuit loops back through COLLECT on the next turn.
  it('should provide fresh PassData on each COLLECT entry across ESC quick-return', async () => {
    const deps = createMockDeps();
    const passSnapshots: { rawToolCalls: unknown[]; assistantContent: string }[] = [];
    let collectCalls = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => AgentState.COLLECT),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async (_env, _turn, pass) => {
        collectCalls++;
        passSnapshots.push({ rawToolCalls: [...pass.rawToolCalls], assistantContent: pass.assistantContent });
        // First COLLECT: mutate pass, then go LLM → ESC → PROMPT → COLLECT again
        if (collectCalls === 1) {
          pass.rawToolCalls = [{ id: 'stale', function: { name: 'bash', arguments: {} } }] as never;
          pass.assistantContent = 'stale content';
          return AgentState.LLM;
        }
        return null; // exit on second COLLECT
      }),
      [AgentState.LLM]: vi.fn(async () => AgentState.PROMPT), // ESC quick-return
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    await buildMachine(deps, handlers).run();

    // Second COLLECT must have FRESH PassData (empty), not the stale mutation.
    expect(passSnapshots[0].rawToolCalls).toEqual([]);
    expect(passSnapshots[1].rawToolCalls).toEqual([]);
    expect(passSnapshots[1].assistantContent).toBe('');
  });

  // [5] ESC during a multi-tool pipeline: LLM returns PROMPT, aborting the turn,
  //     and the loop exits cleanly when PROMPT then returns null.
  it('should exit cleanly when PROMPT returns null after the ESC quick-return path', async () => {
    const deps = createMockDeps();
    const visited: AgentState[] = [];
    let promptCalls = 0;

    const handlers: Record<AgentState, StateHandler> = {
      [AgentState.PROMPT]: vi.fn(async () => {
        promptCalls++;
        visited.push(AgentState.PROMPT);
        // First PROMPT → COLLECT; second PROMPT (after ESC) → exit
        return promptCalls === 1 ? AgentState.COLLECT : null;
      }),
      [AgentState.SLASH]: vi.fn(),
      [AgentState.COLLECT]: vi.fn(async () => { visited.push(AgentState.COLLECT); return AgentState.LLM; }),
      [AgentState.LLM]: vi.fn(async () => { visited.push(AgentState.LLM); return AgentState.PROMPT; }),
      [AgentState.HOOK]: vi.fn(),
      [AgentState.TOOL]: vi.fn(),
      [AgentState.STOP]: vi.fn(),
    };

    await buildMachine(deps, handlers).run();

    // Loop terminated cleanly after the second PROMPT returned null.
    expect(visited).toEqual([AgentState.PROMPT, AgentState.COLLECT, AgentState.LLM, AgentState.PROMPT]);
    expect(handlers[AgentState.PROMPT]).toHaveBeenCalledTimes(2);
    // No SLASH branch was entered
    expect(handlers[AgentState.SLASH]).not.toHaveBeenCalled();
  });
});