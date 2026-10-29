/**
 * tests for the HookExecutor PIPELINE (processToolCalls) - split out of
 * hooks.test.ts.
 *
 * The split is behavioural, not structural:
 *   - hooks.test.ts           one hook, one action, one call: what each action
 *                             type (inject_before / inject_after / block /
 *                             replace / message) does, plus checkHooks(),
 *                             the per-chat duplicate guard and createToolCall().
 *   - hooks-pipeline.test.ts  the batch driver: processToolCalls() over several
 *                             pending calls, the per-turn dedup for stop hooks,
 *                             the end-to-end integration scenarios (sequence +
 *                             registry + executor), and the call.args.*
 *                             CallContext mapping regression.
 *
 * Every test moved verbatim into a scoped describe(); no `it` was dropped.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookExecutor, createToolCall } from '../hook/hook-executor.js';
import { ConditionRegistry } from '../hook/conditions.js';
import { Sequence } from '../hook/sequence.js';
import type { ToolCall, AgentContext } from '../types.js';
import { createMockContext } from './test-utils/index.js';

// ============================================================================
// HookExecutor pipeline tests (processToolCalls)
// ============================================================================

describe('HookExecutor pipeline (processToolCalls)', () => {
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

  describe('execute() - replace on stop trigger (empty pendingCalls)', () => {

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



  });

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
      // A name-only assertion passes even when the injected args are dropped
      // or mangled; pin the arguments the condition's action declared.
      // (arguments is the ollama-shape OBJECT, not a JSON string.)
      expect(result.newCalls?.[0].function.arguments).toEqual({
        query: 'error',
        domain: 'pitfall',
      });
    });
  });

  describe('call.args.* populated end-to-end via processToolCalls', () => {
    const getSkill = () => ({ content: 'skill body' });

    it('a guarded call.args.command condition fires true when the command matches', async () => {
      registry.set('release-hook', {
        trigger: ['bash'],
        when: 'prepare a GitHub release',
        condition: "call.args.command && call.args.command.includes('gh release')",
        action: { type: 'message', message: 'release helper' },
        version: 1,
      });

      const call: ToolCall = {
        id: 'c1',
        function: { name: 'bash', arguments: { command: 'gh release create v1' } },
      };
      const result = await executor.processToolCalls([call], ctx, getSkill);

      // The condition saw call.args.command and matched → hook contributed its message.
      expect(result.deferredMessages.some((m) => m.hookName === 'release-hook')).toBe(true);
      expect(registry.getErroredConditions()).toHaveLength(0);
    });

    it('a guarded condition does NOT throw when the call has no command arg', async () => {
      registry.set('release-hook', {
        trigger: ['bash'],
        when: 'prepare a GitHub release',
        condition: "call.args.command && call.args.command.includes('gh release')",
        action: { type: 'message', message: 'release helper' },
        version: 1,
      });

      // A bash call whose arguments lack `command` (e.g. a malformed/partial call).
      const call: ToolCall = {
        id: 'c2',
        function: { name: 'bash', arguments: {} },
      };
      await executor.processToolCalls([call], ctx, getSkill);

      // Guarded access → no crash, no failure recorded.
      expect(registry.getErroredConditions()).toHaveLength(0);
    });

    it('an UNGUARDED call.args.command.includes still fails LOUDLY (error recorded)', async () => {
      registry.set('bad-hook', {
        trigger: ['bash'],
        when: 'bad condition',
        condition: "call.args.command.includes('gh release')",
        action: { type: 'message', message: 'x' },
        version: 1,
      });

      const call: ToolCall = {
        id: 'c3',
        function: { name: 'bash', arguments: {} },
      };
      await executor.processToolCalls([call], ctx, getSkill);

      // The unguarded access threw and was attributed to the hook for recompile.
      const errored = registry.getErroredConditions();
      expect(errored).toHaveLength(1);
      expect(errored[0].name).toBe('bad-hook');
    });
  });

});
