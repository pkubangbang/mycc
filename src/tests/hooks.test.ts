/**
 * Tests for hooks.ts
 *
 * Tests cover:
 * - HookExecutor.checkHooks()
 * - All action types (inject_before, inject_after, block, replace, message)
 * - Duplicate prevention
 * - Tool call modification
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookExecutor, createToolCall } from '../hook/hook-executor.js';
import { ConditionRegistry } from '../hook/conditions.js';
import { Sequence } from '../hook/sequence.js';
import type { ToolCall, AgentContext, CoreModule } from '../types.js';

// ============================================================================
// Mock Helpers
// ============================================================================

// Note: We test against the exported createToolCall from hooks.ts
// which generates IDs like: hook-{skillName}-{timestamp}

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
    getMode: vi.fn(() => 'normal' as const),
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

function createPendingToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${Date.now()}`,
    function: {
      name,
      arguments: args,
    },
  };
}

// ============================================================================
// HookExecutor Tests
// ============================================================================

describe('HookExecutor', () => {
  let registry: ConditionRegistry;
  let sequence: Sequence;
  let executor: HookExecutor;
  let ctx: AgentContext;

  beforeEach(() => {
    registry = new ConditionRegistry();
    sequence = new Sequence();
    executor = new HookExecutor(registry, sequence);
    ctx = createMockContext();
  });

  // ============================================================================
  // checkHooks()
  // ============================================================================

  describe('checkHooks()', () => {
    it('should return empty array when no conditions registered', () => {
      const hooks = executor.checkHooks('bash');
      expect(hooks).toEqual([]);
    });

    it('should return matching hooks for trigger', () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const hooks = executor.checkHooks('bash');
      expect(hooks).toContain('test-hook');
    });

    it('should return wildcard hooks for any trigger', () => {
      registry.set('any-hook', {
        trigger: ['*'],
        when: 'any tool',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const hooks = executor.checkHooks('bash');
      expect(hooks).toContain('any-hook');

      const hooks2 = executor.checkHooks('edit_file');
      expect(hooks2).toContain('any-hook');
    });

    it('should not return hooks for different trigger', () => {
      registry.set('bash-hook', {
        trigger: ['bash'],
        when: 'bash only',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const hooks = executor.checkHooks('edit_file');
      expect(hooks).not.toContain('bash-hook');
    });

    it('should only return hooks whose condition evaluates to true', () => {
      registry.set('has-edits', {
        trigger: ['git_commit'],
        when: 'has file edits',
        condition: 'turn.count("edit_file") > 0 || turn.count("write_file") > 0',
        action: { type: 'message' },
        version: 1,
      });

      // No edits - condition false
      expect(executor.checkHooks('git_commit')).not.toContain('has-edits');

      // Add edit
      sequence.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 1000 });

      // Now condition true
      expect(executor.checkHooks('git_commit')).toContain('has-edits');
    });

    it('should always match hooks regardless of prior injection', () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      // First check
      expect(executor.checkHooks('bash')).toContain('test-hook');

      // Mark as injected
      registry.markInjected('test-hook');

      // Second check - should still match (per-chat dedup happens in execute(), not matches())
      expect(executor.checkHooks('bash')).toContain('test-hook');
    });
  });

  // ============================================================================
  // execute() - inject_before
  // ============================================================================

  describe('execute() - inject_before', () => {
    it('should inject tool call before trigger', async () => {
      registry.set('lint-hook', {
        trigger: ['git_commit'],
        when: 'run lint before commit',
        condition: 'true',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'pnpm lint', intent: 'pre-commit lint' },
        },
        version: 1,
      });

      const pendingCalls = [createPendingToolCall('git_commit', { message: 'test' })];
      const result = await executor.execute(
        'lint-hook',
        registry.get('lint-hook')!.action,
        ctx,
        pendingCalls,
        'Run lint before commit'
      );

      expect(result.action).toBe('injected');
      expect(result.newCalls).toHaveLength(2);
      expect(result.newCalls?.[0].function.name).toBe('bash'); // Injected first
      expect(result.newCalls?.[1].function.name).toBe('git_commit'); // Original second
    });

    it('should preserve original tool call arguments', async () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: {
          type: 'inject_before',
          tool: 'read_file',
          args: { path: 'test.ts' },
        },
        version: 1,
      });

      const pendingCalls = [createPendingToolCall('bash', { command: 'echo test' })];
      const result = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );

      expect(result.newCalls?.[1].function.arguments).toEqual({ command: 'echo test' });
    });

    it('should report the injection via core.brief with the trigger and hook name', async () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'echo test' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'original' }, 'test-hook')];
      await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Skill content here'
      );

      // Core.brief should be called with the injection detail.
      expect(ctx.core.brief).toHaveBeenCalledWith(
        'info',
        'hook',
        'bash(command=echo test) injected BEFORE bash',
        'bash → test-hook'
      );
    });
  });

  // ============================================================================
  // execute() - inject_after
  // ============================================================================

  describe('execute() - inject_after', () => {
    it('should inject tool call after trigger', async () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'run tests after',
        condition: 'true',
        action: {
          type: 'inject_after',
          tool: 'bash',
          args: { command: 'pnpm test', intent: 'post-edit tests' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'original' }, 'test-hook')];
      const result = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Run tests after'
      );

      expect(result.action).toBe('injected');
      expect(result.newCalls).toHaveLength(2);
      expect(result.newCalls?.[0].function.name).toBe('bash'); // Original first
      expect(result.newCalls?.[1].function.name).toBe('bash'); // Injected second
    });

    it('should handle multiple pending calls', async () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: {
          type: 'inject_after',
          tool: 'read_file',
          args: { path: 'test.ts' },
        },
        version: 1,
      });

      const pendingCalls = [
        createToolCall('bash', { command: 'first' }, 'test-hook'),
        createToolCall('bash', { command: 'second' }, 'test-hook'),
      ];
      const result = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test'
      );

      expect(result.newCalls).toHaveLength(3);
      expect(result.newCalls?.[0].function.name).toBe('bash');
      expect(result.newCalls?.[1].function.name).toBe('read_file'); // Injected after first
      expect(result.newCalls?.[2].function.name).toBe('bash');
    });
  });

  // ============================================================================
  // execute() - block
  // ============================================================================

  describe('execute() - block', () => {
    it('should return blocked result', async () => {
      registry.set('block-force', {
        trigger: ['bash'],
        when: 'block force push',
        condition: 'true',
        action: {
          type: 'block',
          reason: 'Force push to main is prohibited',
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'git push --force' }, 'test-hook')];
      const result = await executor.execute(
        'block-force',
        registry.get('block-force')!.action,
        ctx,
        pendingCalls,
        'Block force push'
      );

      expect(result.action).toBe('blocked');
      expect(result.message).toContain('[Hook: block-force]');
      expect(result.message).toContain('Force push to main is prohibited');
    });

    it('should work without reason', async () => {
      registry.set('block-any', {
        trigger: ['bash'],
        when: 'block any',
        condition: 'true',
        action: { type: 'block' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' }, 'test-hook')];
      const result = await executor.execute(
        'block-any',
        registry.get('block-any')!.action,
        ctx,
        pendingCalls,
        'Block content'
      );

      expect(result.action).toBe('blocked');
      expect(result.message).toContain('[Hook: block-any]');
      expect(result.message).toContain('no reason provided');
    });
  });

  // ============================================================================
  // execute() - replace
  // ============================================================================

  describe('execute() - replace', () => {
    it('should replace tool call with different tool', async () => {
      registry.set('replace-hook', {
        trigger: ['bash'],
        when: 'replace with safe command',
        condition: 'true',
        action: {
          type: 'replace',
          tool: 'bash',
          args: { command: 'echo safe', intent: 'safety' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'rm -rf /' }, 'test-hook')];
      const result = await executor.execute(
        'replace-hook',
        registry.get('replace-hook')!.action,
        ctx,
        pendingCalls,
        'Replace content'
      );

      expect(result.action).toBe('injected');
      expect(result.newCalls).toHaveLength(1);
      expect(result.newCalls?.[0].function.name).toBe('bash');
      expect(result.newCalls?.[0].function.arguments).toEqual({ command: 'echo safe', intent: 'safety' });
    });

    it('should replace with different tool type', async () => {
      registry.set('replace-hook', {
        trigger: ['web_search'],
        when: 'use wiki instead',
        condition: 'true',
        action: {
          type: 'replace',
          tool: 'wiki_get',
          args: { query: 'project', domain: 'pitfall' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('web_search', { query: 'test' }, 'test-hook')];
      const result = await executor.execute(
        'replace-hook',
        registry.get('replace-hook')!.action,
        ctx,
        pendingCalls,
        'Use wiki'
      );

      expect(result.newCalls?.[0].function.name).toBe('wiki_get');
    });
  });

  // ============================================================================
  // execute() - replace on STOP trigger (empty pendingCalls)
  // ============================================================================

  describe('execute() - replace on stop trigger (empty pendingCalls)', () => {
    it('should not crash and should inject the replacement call when pendingCalls is empty', async () => {
      registry.set('plan-quality', {
        trigger: ['stop'],
        when: 'replace stop with skill load',
        condition: 'isPlanMode() && session.count("skill_load#plan-quality") == 0',
        action: {
          type: 'replace',
          tool: 'skill_load',
          args: { name: 'plan-quality' },
        },
        version: 1,
      });

      // Empty pendingCalls simulates the stop trigger (no pending tool calls).
      // Before the fix, replace() dereferenced pendingCalls[0] and crashed.
      const result = await executor.execute(
        'plan-quality',
        registry.get('plan-quality')!.action,
        ctx,
        [], // empty = stop trigger
        'Replace the stop with loading this skill'
      );

      expect(result.action).toBe('injected');
      expect(result.newCalls).toHaveLength(1);
      expect(result.newCalls?.[0].function.name).toBe('skill_load');
      expect(result.newCalls?.[0].function.arguments).toEqual({ name: 'plan-quality' });
    });

    it('processStopTrigger should replace stop with a skill_load call end-to-end', async () => {
      // Use plan mode so isPlanMode() is true. The shared beforeEach
      // sequence has no mode getter (defaults to normal), so build a plan-mode
      // sequence + executor bound to it for this test.
      (ctx.core.getMode as ReturnType<typeof vi.fn>).mockReturnValue('plan' as const);
      const planSequence = new Sequence(undefined, () => 'plan');
      const planExecutor = new HookExecutor(registry, planSequence);

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

      // processToolCalls with empty calls = stop trigger
      const result = await planExecutor.processToolCalls(
        [],
        ctx,
        (name) => (name === 'plan-quality' ? { content: 'skill body' } : undefined)
      );

      // The stop should have been replaced with one skill_load call
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].function.name).toBe('skill_load');
      expect(result.calls[0].function.arguments).toEqual({ name: 'plan-quality' });
    });
  });

  // ============================================================================
  // Per-turn dedup for stop+block/replace hooks (stopDisturbance)
  // ============================================================================

  describe('per-turn dedup for stop+block/replace hooks', () => {
    // Helper: build a plan-mode executor (the shared beforeEach sequence
    // defaults to normal mode, so stop hooks gated on isPlanMode() won't fire).
    function planModeExecutor(): HookExecutor {
      const planSequence = new Sequence(undefined, () => 'plan');
      return new HookExecutor(registry, planSequence);
    }
    const getSkill = (n: string) => (n === 'plan-quality' ? { content: 'skill body' } : undefined);

    it('a stop+replace hook acts at most once per turn across multiple processToolCalls batches', async () => {
      (ctx.core.getMode as ReturnType<typeof vi.fn>).mockReturnValue('plan' as const);
      const ex = planModeExecutor();

      registry.set('plan-quality', {
        trigger: ['stop'],
        when: 'replace stop with skill load',
        condition: 'isPlanMode() && session.count("skill_load#plan-quality") == 0',
        action: {
          type: 'replace',
          tool: 'skill_load',
          args: { name: 'plan-quality' },
        },
        version: 1,
      });

      // Batch 1: stop trigger fires → replaces stop with skill_load
      const r1 = await ex.processToolCalls([], ctx, getSkill);
      expect(r1.calls).toHaveLength(1);
      expect(r1.calls[0].function.name).toBe('skill_load');

      // Batch 2 (same turn, e.g. after the skill_load resolves and the agent
      // stops again): the hook must NOT re-fire — otherwise it would loop
      // forever replacing stop with skill_load. injectedThisChat is cleared
      // each processToolCalls call, so without stopDisturbance this would fire.
      const r2 = await ex.processToolCalls([], ctx, getSkill);
      expect(r2.calls).toHaveLength(0); // stop proceeds — no re-replacement
    });

    it('resetTurn() re-enables a stop+replace hook for the next turn', async () => {
      (ctx.core.getMode as ReturnType<typeof vi.fn>).mockReturnValue('plan' as const);
      const ex = planModeExecutor();

      registry.set('plan-quality', {
        trigger: ['stop'],
        when: 'replace stop with skill load',
        condition: 'isPlanMode() && session.count("skill_load#plan-quality") == 0',
        action: {
          type: 'replace',
          tool: 'skill_load',
          args: { name: 'plan-quality' },
        },
        version: 1,
      });

      // Turn 1, batch 1: fires
      await ex.processToolCalls([], ctx, getSkill);

      // Turn boundary — resetTurn() is called by the agent loop at PROMPT
      ex.resetTurn();

      // Turn 2, batch 1: fires again (new turn, fresh allowance)
      const r = await ex.processToolCalls([], ctx, getSkill);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].function.name).toBe('skill_load');
    });

    it('multiple distinct stop+replace hooks each act once per turn', async () => {
      (ctx.core.getMode as ReturnType<typeof vi.fn>).mockReturnValue('plan' as const);
      const ex = planModeExecutor();

      registry.set('hook-a', {
        trigger: ['stop'],
        when: 'a',
        condition: 'isPlanMode()',
        action: { type: 'replace', tool: 'skill_load', args: { name: 'a' } },
        version: 1,
      });
      registry.set('hook-b', {
        trigger: ['stop'],
        when: 'b',
        condition: 'isPlanMode()',
        action: { type: 'replace', tool: 'skill_load', args: { name: 'b' } },
        version: 1,
      });

      const anySkill = (_n: string) => ({ content: 'skill body' });

      // First batch: only the highest-priority-first stop hook acts (replace
      // is priority 1, first-wins within the priority group, so only ONE
      // replace fires per processToolCalls — the other is not reached this
      // batch because processStopTrigger returns early for priority < 2).
      const r1 = await ex.processToolCalls([], ctx, anySkill);
      // Exactly one replacement happened this batch
      expect(r1.calls).toHaveLength(1);
      const actedFirst = r1.calls[0].function.arguments as { name: string };

      // Second batch (same turn): the hook that already acted must NOT re-fire,
      // but the OTHER distinct hook may still act once.
      const r2 = await ex.processToolCalls([], ctx, anySkill);
      expect(r2.calls).toHaveLength(1);
      const actedSecond = r2.calls[0].function.arguments as { name: string };
      // The second batch's actor is the OTHER hook (distinct allowance)
      expect(actedSecond.name).not.toBe(actedFirst.name);

      // Third batch (same turn): both have now acted → stop proceeds
      const r3 = await ex.processToolCalls([], ctx, anySkill);
      expect(r3.calls).toHaveLength(0);
    });

    it('inject_before hooks are NOT capped per-turn (may fire on every batch)', async () => {
      const ex = planModeExecutor();

      registry.set('inject-stop', {
        trigger: ['stop'],
        when: 'inject on stop every batch',
        condition: 'true',
        action: { type: 'inject_before', tool: 'bash', args: { command: 'echo hi', intent: 'TEST ARTIFACT TO greet' } },
        version: 1,
      });

      // Batch 1
      const r1 = await ex.processToolCalls(
        [], ctx, (n) => (n === 'inject-stop' ? { content: 'skill body' } : undefined)
      );
      expect(r1.calls).toHaveLength(1);
      expect(r1.calls[0].function.name).toBe('bash');

      // Batch 2 (same turn): inject_before is NOT capped → fires again
      const r2 = await ex.processToolCalls(
        [], ctx, (n) => (n === 'inject-stop' ? { content: 'skill body' } : undefined)
      );
      expect(r2.calls).toHaveLength(1);
      expect(r2.calls[0].function.name).toBe('bash');
    });
  });

  // ============================================================================
  // execute() - message
  // ============================================================================

  describe('execute() - message', () => {
    it('should return proceed with message', async () => {
      registry.set('msg-hook', {
        trigger: ['bash'],
        when: 'reminder',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' }, 'test-hook')];
      const result = await executor.execute(
        'msg-hook',
        registry.get('msg-hook')!.action,
        ctx,
        pendingCalls,
        'Remember to run tests!'
      );

      expect(result.action).toBe('proceed');
      expect(result.message).toContain('msg-hook');
      expect(result.newCalls).toBeUndefined();
    });
  });

  // ============================================================================
  // Per-chat duplicate prevention
  // ============================================================================

  describe('per-chat duplicate prevention', () => {
    it('should deduplicate within the same chat', async () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' }, 'test-hook')];

      // First execution in this move
      const result1 = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );
      expect(result1.message).toContain('test-hook');

      // Second execution in same chat — should be deduped
      const result2 = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );
      expect(result2.message).toContain('already injected this chat');
    });

    it('should allow reactivation in a new move', async () => {
      registry.set('test-hook', {
        trigger: ['bash'],
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' }, 'test-hook')];

      // First move
      let result = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );
      expect(result.message).toContain('test-hook');

      // Simulate new move — processToolCalls clears injectedThisChat
      await executor.processToolCalls([], ctx, (name) =>
        name === 'test-hook' ? { content: 'Test content' } : undefined
      );

      // New move — should activate again
      result = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );
      expect(result.message).toContain('test-hook');
    });
  });

  // ============================================================================
  // Integration Scenarios
  // ============================================================================

  describe('integration scenarios', () => {
    it('should handle pre-commit lint hook scenario', async () => {
      // Set up condition: run lint if files edited and no lint yet
      registry.set('pre-commit-lint', {
        trigger: ['git_commit'],
        when: 'run lint before commit if files changed',
        condition: '(turn.count("edit_file") > 0 || turn.count("write_file") > 0) && turn.lastIndex("bash#pnpm lint") == -1',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'pnpm lint', intent: 'pre-commit lint check', timeout: 60 },
        },
        version: 1,
      });

      // User edited files
      sequence.add({ tool: 'edit_file', args: { path: 'src/test.ts' }, result: 'ok', timestamp: 1000 });

      // Check hooks
      const hooks = executor.checkHooks('git_commit');
      expect(hooks).toContain('pre-commit-lint');

      // Execute
      const pendingCalls = [createToolCall('git_commit', { message: 'feat: add tests' }, 'test-hook')];
      const result = await executor.execute(
        'pre-commit-lint',
        registry.get('pre-commit-lint')!.action,
        ctx,
        pendingCalls,
        'Run lint before commit'
      );

      expect(result.action).toBe('injected');
      expect(result.newCalls?.[0].function.name).toBe('bash');
      expect(result.newCalls?.[0].function.arguments.command).toBe('pnpm lint');
    });

    it('should not inject lint if already run', async () => {
      registry.set('pre-commit-lint', {
        trigger: ['git_commit'],
        when: 'run lint before commit',
        condition: '(turn.count("edit_file") > 0 || turn.count("write_file") > 0) && turn.lastIndex("bash#pnpm lint") == -1',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'pnpm lint' },
        },
        version: 1,
      });

      // User edited files AND ran lint
      sequence.add({ tool: 'edit_file', args: { path: 'src/test.ts' }, result: 'ok', timestamp: 1000 });
      sequence.add({ tool: 'bash', args: { command: 'pnpm lint' }, result: 'ok', timestamp: 2000 });

      // Check hooks - condition should be false
      const hooks = executor.checkHooks('git_commit');
      expect(hooks).not.toContain('pre-commit-lint');
    });

    it('should block force push to main', async () => {
      registry.set('block-force-main', {
        trigger: ['bash'],
        when: 'block force push to main',
        condition: 'turn.count("bash#git push --force") > 0',
        action: {
          type: 'block',
          reason: 'Force pushing to main branch is prohibited. Please create a feature branch.',
        },
        version: 1,
      });

      // Normal push
      sequence.add({ tool: 'bash', args: { command: 'git push origin main' }, result: 'ok', timestamp: 1000 });
      expect(executor.checkHooks('bash')).not.toContain('block-force-main');

      // Force push attempt
      sequence.add({ tool: 'bash', args: { command: 'git push --force origin main' }, result: 'ok', timestamp: 2000 });
      expect(executor.checkHooks('bash')).toContain('block-force-main');

      // Execute block
      const pendingCalls = [createToolCall('bash', { command: 'git push --force origin main' }, 'test-hook')];
      const result = await executor.execute(
        'block-force-main',
        registry.get('block-force-main')!.action,
        ctx,
        pendingCalls,
        'Block force push to main'
      );

      expect(result.action).toBe('blocked');
    });

    it('should search wiki on errors', async () => {
      registry.set('error-wiki', {
        trigger: ['*'],
        when: 'search wiki on error',
        condition: 'turn.hadError()',
        action: {
          type: 'inject_before',
          tool: 'wiki_get',
          args: { query: 'error', domain: 'pitfall' },
        },
        version: 1,
      });

      // No error
      sequence.add({ tool: 'bash', args: { command: 'echo ok' }, result: 'ok', timestamp: 1000 });
      expect(executor.checkHooks('bash')).not.toContain('error-wiki');

      // Error occurs
      sequence.add({ tool: 'bash', args: { command: 'build' }, result: 'Error: build failed', timestamp: 2000 });
      expect(executor.checkHooks('bash')).toContain('error-wiki');

      // Execute
      const pendingCalls = [createToolCall('bash', { command: 'next-cmd' }, 'test-hook')];
      const result = await executor.execute(
        'error-wiki',
        registry.get('error-wiki')!.action,
        ctx,
        pendingCalls,
        'Search wiki for errors'
      );

      expect(result.action).toBe('injected');
      expect(result.newCalls?.[0].function.name).toBe('wiki_get');
    });
  });
});

// ============================================================================
// createToolCall()
// ============================================================================

describe('createToolCall()', () => {
  it('should create valid tool call', () => {
    const call = createToolCall('bash', { command: 'test' }, 'test-skill');

    expect(call.id).toContain('hook-test-skill');
    expect(call.function.name).toBe('bash');
    expect(call.function.arguments).toEqual({ command: 'test' });
  });

  it('should create unique IDs for different skills', () => {
    const call1 = createToolCall('bash', {}, 'skill1');
    const call2 = createToolCall('bash', {}, 'skill2');

    expect(call1.id).toContain('skill1');
    expect(call2.id).toContain('skill2');
    expect(call1.id).not.toBe(call2.id);
  });

  it('should include skill name in ID', () => {
    const call = createToolCall('bash', {}, 'my-special-skill');
    expect(call.id).toContain('hook-my-special-skill');
  });
});