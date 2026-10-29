/**
 * Tests for hooks.ts
 *
 * Tests cover:
 * - HookExecutor.checkHooks()
 * - All action types (inject_before, inject_after, block, replace, message)
 * - Duplicate prevention
 * - Tool call modification
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookExecutor, createToolCall } from '../hook/hook-executor.js';
import { ConditionRegistry } from '../hook/conditions.js';
import { Sequence } from '../hook/sequence.js';
import type { ToolCall, AgentContext } from '../types.js';
import { createMockContext } from './test-utils/index.js';

// ============================================================================
// Mock Helpers
// ============================================================================

// Note: we test against the exported createToolCall from hooks.ts, which
// generates IDs like: hook-{skillName}-{timestamp}
//
// The AgentContext comes from the CANONICAL shared factory
// (test-utils/mock-context.ts) - no local createMockCore/createMockContext
// copy. Only fields a test actually asserts on are overridden per test.

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

  });

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

      // Core.brief should be called with the injection detail. The final
      // opts arg carries synthetic:true — hook briefs are machine-originated
      // and hidden from the WebUI chat log.
      expect(ctx.core.brief).toHaveBeenCalledWith(
        'info',
        'hook',
        'bash(command=echo test) injected BEFORE bash',
        'bash → test-hook',
        { synthetic: true }
      );
    });
  });

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
      // Both calls target `bash`, so names alone cannot prove ordering —
      // compare the ARGUMENTS: the original first, the hook's after it.
      // (arguments is the ollama-shape OBJECT, not a JSON string.)
      expect(result.newCalls?.[0].function.name).toBe('bash');
      expect(result.newCalls?.[0].function.arguments).toMatchObject({ command: 'original' });
      expect(result.newCalls?.[1].function.name).toBe('bash');
      expect(result.newCalls?.[1].function.arguments).toMatchObject({ command: 'pnpm test' });
    });

  });

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

  });

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

  });

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


});
