/**
 * compact-reset-session-state.test.ts
 *
 * Regression test for: "the session.* of the condition evaluator should reset
 * when /clear or /compact".
 *
 * The plan-quality hook uses a stop+replace action gated by
 *   isPlanMode() && session.count('skill_load#plan-quality') == 0
 * to fire "once per session". After it fires, the injected skill_load tool
 * call is executed and recorded via sequence.add(), so
 * session.count('skill_load#plan-quality') becomes 1 and the hook won't
 * re-fire — the intended "fire once per session" dedup.
 *
 * The bug: after /clear or /compact, sequence.clear() resets session.count
 * back to 0, BUT the HookExecutor also keeps two in-memory dedup sets:
 *   - injectedThisChat  (cleared each processToolCalls call — not a concern)
 *   - stopDisturbance   (cleared ONLY by resetTurn(), called at the PROMPT
 *                        turn boundary)
 *
 * /clear and /compact run in the SLASH state and call sequence.clear() but
 * did NOT call hookExecutor.resetTurn(). Auto-compact in llm.ts likewise called
 * sequence.clear() without resetTurn(). Because auto-compact fires mid-turn
 * (at the LLM stage) with no subsequent PROMPT/resetTurn boundary, the dedup
 * cap persisted for the rest of the turn even though the session.* counters
 * it was deduping against had been reset — so a session-deduplicated stop hook
 * stayed suppressed after compaction.
 *
 * The fix mirrors the established PROMPT-state pattern (which pairs
 * sequence.markPromptBoundary() with hookExecutor.resetTurn()): every call
 * site that clears sequence state on a /clear, /compact, or auto-compact
 * now ALSO calls hookExecutor.resetTurn(). This test pins that contract by
 * simulating the real call-site pairing — clear() followed by resetTurn() —
 * and asserting the hook re-fires.
 */

import { describe, it, expect, vi } from 'vitest';
import { HookExecutor } from '../../hook/hook-executor.js';
import { ConditionRegistry } from '../../hook/conditions.js';
import { Sequence } from '../../hook/sequence.js';
import type { AgentContext, CoreModule } from '../../types.js';

function createMockCore(): CoreModule {
  return {
    getWorkDir: () => '/test',
    setWorkDir: () => {},
    getName: () => 'test-agent',
    brief: vi.fn(),
    verbose: vi.fn(),
    question: vi.fn(),
    webSearch: vi.fn(),
    webFetch: vi.fn(),
    imgDescribe: vi.fn(),
    readPictureCached: vi.fn(),
    requestGrant: vi.fn(async () => ({ approved: true })),
    requestExternalPathAccess: vi.fn(async (_tool, path) => ({ approved: true, resolvedPath: path })),
    addExternalAutoGrant: vi.fn(),
    getMode: vi.fn(() => 'plan' as const),
    getAuto: vi.fn(() => false),
    setAuto: vi.fn(),
    getMindmap: vi.fn(() => null),
    setMindmap: vi.fn(),
    getConfusionIndex: vi.fn(() => 0),
    increaseConfusionIndex: vi.fn(),
    resetConfusionIndex: vi.fn(),
    escAware: (vi.fn() as unknown) as CoreModule['escAware'],
  };
}

function createMockContext(): AgentContext {
  return {
    core: createMockCore(),
    todo: {} as AgentContext['todo'],
    mail: {} as AgentContext['mail'],
    skill: {} as AgentContext['skill'],
    issue: {} as AgentContext['issue'],
    bg: {} as AgentContext['bg'],
    team: {} as AgentContext['team'],
    wiki: {} as AgentContext['wiki'],
    peer: {} as AgentContext['peer'],
  };
}

describe('session.* reset on /clear or /compact re-enables session-dedup hooks', () => {
  const getSkill = (n: string) => (n === 'plan-quality' ? { content: 'skill body' } : undefined);

  function registerPlanQuality(registry: ConditionRegistry): void {
    registry.set('plan-quality', {
      trigger: ['stop'],
      when: 'replace stop with skill load when in plan mode and skill not loaded',
      condition: 'isPlanMode() && session.count("skill_load#plan-quality") == 0',
      action: {
        type: 'replace',
        tool: 'skill_load',
        args: { name: 'plan-quality' },
      },
      version: 1,
    });
  }

  it('reproduces: hook fires, skill_load recorded, count==1 blocks re-fire; clear() should restore re-fire', async () => {
    const ctx = createMockContext();
    const registry = new ConditionRegistry();
    registerPlanQuality(registry);

    // plan-mode sequence + executor (shared by all states, as in agent-repl.ts)
    const sequence = new Sequence(undefined, () => 'plan');
    const executor = new HookExecutor(registry, sequence);

    // ── First stop trigger: hook fires, replacing stop with skill_load ──
    const r1 = await executor.processToolCalls([], ctx, getSkill);
    expect(r1.calls).toHaveLength(1);
    expect(r1.calls[0].function.name).toBe('skill_load');
    expect(r1.calls[0].function.arguments).toEqual({ name: 'plan-quality' });

    // The agent loop executes the injected skill_load via the TOOL state,
    // which calls sequence.add(...) — this is what makes the "fire once per
    // session" dedup actually take effect. Simulate that here.
    sequence.add({
      tool: 'skill_load',
      args: { name: 'plan-quality' },
      result: 'skill body',
      timestamp: Date.now(),
    });

    // session.count is now 1 → condition false → hook must NOT fire
    expect(sequence.sessionCount('skill_load#plan-quality')).toBe(1);
    expect(executor.checkHooks('stop')).not.toContain('plan-quality');

    // ── /compact (or /clear): the call site pairs sequence.clear() with
    //    hookExecutor.resetTurn() (mirroring the PROMPT-state pattern that
    //    pairs markPromptBoundary() with resetTurn()). sequence.clear()
    //    resets the session.* counters; resetTurn() clears the per-turn
    //    stopDisturbance dedup set that was suppressing the hook. ──
    sequence.clear();
    executor.resetTurn();
    expect(sequence.sessionCount('skill_load#plan-quality')).toBe(0);

    // ── Next stop trigger: hook should fire AGAIN ──
    const r2 = await executor.processToolCalls([], ctx, getSkill);
    // EXPECTED (the user's requirement): the hook re-fires and injects
    // a skill_load call. If r2.calls is empty, the bug is reproduced — the
    // clear path reset session.* but did not reset hook executor dedup
    // state (stopDisturbance), so the hook stays suppressed.
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0].function.name).toBe('skill_load');
    expect(r2.calls[0].function.arguments).toEqual({ name: 'plan-quality' });
  });
});