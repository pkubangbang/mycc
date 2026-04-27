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
import { HookExecutor, createToolCall } from '../context/shared/hooks.js';
import { ConditionRegistry, type Condition, type HookAction } from '../context/shared/conditions.js';
import { Sequence } from '../context/shared/sequence.js';
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
    wt: {} as AgentContext['wt'],
    team: {} as AgentContext['team'],
    wiki: {} as AgentContext['wiki'],
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
        trigger: 'bash',
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
        trigger: '*',
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
        trigger: 'bash',
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
        trigger: 'git_commit',
        when: 'has file edits',
        condition: 'seq.hasAny(["edit_file", "write_file"])',
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

    it('should skip already injected hooks', () => {
      registry.set('test-hook', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      // First check
      expect(executor.checkHooks('bash')).toContain('test-hook');

      // Mark as injected
      registry.markInjected('test-hook');

      // Second check - should skip
      expect(executor.checkHooks('bash')).not.toContain('test-hook');
    });
  });

  // ============================================================================
  // execute() - inject_before
  // ============================================================================

  describe('execute() - inject_before', () => {
    it('should inject tool call before trigger', async () => {
      registry.set('lint-hook', {
        trigger: 'git_commit',
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
        trigger: 'bash',
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

    it('should include skill content reference', async () => {
      registry.set('test-hook', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'echo test' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'original' })];
      await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Skill content here'
      );

      // Core.brief should be called
      expect(ctx.core.brief).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // execute() - inject_after
  // ============================================================================

  describe('execute() - inject_after', () => {
    it('should inject tool call after trigger', async () => {
      registry.set('test-hook', {
        trigger: 'bash',
        when: 'run tests after',
        condition: 'true',
        action: {
          type: 'inject_after',
          tool: 'bash',
          args: { command: 'pnpm test', intent: 'post-edit tests' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'original' })];
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
        trigger: 'bash',
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
        createToolCall('bash', { command: 'first' }),
        createToolCall('bash', { command: 'second' }),
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
        trigger: 'bash',
        when: 'block force push',
        condition: 'true',
        action: {
          type: 'block',
          reason: 'Force push to main is prohibited',
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'git push --force' })];
      const result = await executor.execute(
        'block-force',
        registry.get('block-force')!.action,
        ctx,
        pendingCalls,
        'Block force push'
      );

      expect(result.action).toBe('blocked');
      expect(result.message).toContain('Blocked');
      expect(result.message).toContain('Force push to main is prohibited');
    });

    it('should work without reason', async () => {
      registry.set('block-any', {
        trigger: 'bash',
        when: 'block any',
        condition: 'true',
        action: { type: 'block' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' })];
      const result = await executor.execute(
        'block-any',
        registry.get('block-any')!.action,
        ctx,
        pendingCalls,
        'Block content'
      );

      expect(result.action).toBe('blocked');
      expect(result.message).toContain('Block content');
    });
  });

  // ============================================================================
  // execute() - replace
  // ============================================================================

  describe('execute() - replace', () => {
    it('should replace tool call with different tool', async () => {
      registry.set('replace-hook', {
        trigger: 'bash',
        when: 'replace with safe command',
        condition: 'true',
        action: {
          type: 'replace',
          tool: 'bash',
          args: { command: 'echo safe', intent: 'safety' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'rm -rf /' })];
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
        trigger: 'web_search',
        when: 'use wiki instead',
        condition: 'true',
        action: {
          type: 'replace',
          tool: 'wiki_get',
          args: { query: 'project', domain: 'pitfall' },
        },
        version: 1,
      });

      const pendingCalls = [createToolCall('web_search', { query: 'test' })];
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
  // execute() - message
  // ============================================================================

  describe('execute() - message', () => {
    it('should return proceed with message', async () => {
      registry.set('msg-hook', {
        trigger: 'bash',
        when: 'reminder',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' })];
      const result = await executor.execute(
        'msg-hook',
        registry.get('msg-hook')!.action,
        ctx,
        pendingCalls,
        'Remember to run tests!'
      );

      expect(result.action).toBe('proceed');
      expect(result.message).toContain('msg-hook');
      expect(result.message).toContain('Remember to run tests!');
      expect(result.newCalls).toBeUndefined();
    });
  });

  // ============================================================================
  // Duplicate Prevention
  // ============================================================================

  describe('duplicate prevention', () => {
    it('should skip already injected hooks', async () => {
      registry.set('test-hook', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      const pendingCalls = [createToolCall('bash', { command: 'test' })];

      // First execution
      const result1 = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );
      expect(result1.message).toContain('Test content');

      // Second execution - should reference existing
      const result2 = await executor.execute(
        'test-hook',
        registry.get('test-hook')!.action,
        ctx,
        pendingCalls,
        'Test content'
      );
      expect(result2.message).toContain('already in conversation');
    });

    it('should mark hook as injected after execution', async () => {
      registry.set('inject-hook', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: {
          type: 'inject_before',
          tool: 'read_file',
          args: { path: 'test.ts' },
        },
        version: 1,
      });

      expect(registry.hasInjected('inject-hook')).toBe(false);

      await executor.execute(
        'inject-hook',
        registry.get('inject-hook')!.action,
        ctx,
        [createToolCall('bash', {})],
        'Test'
      );

      expect(registry.hasInjected('inject-hook')).toBe(true);
    });
  });

  // ============================================================================
  // Integration Scenarios
  // ============================================================================

  describe('integration scenarios', () => {
    it('should handle pre-commit lint hook scenario', async () => {
      // Set up condition: run lint if files edited and no lint yet
      registry.set('pre-commit-lint', {
        trigger: 'git_commit',
        when: 'run lint before commit if files changed',
        condition: 'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#lint")',
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
      const pendingCalls = [createToolCall('git_commit', { message: 'feat: add tests' })];
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
        trigger: 'git_commit',
        when: 'run lint before commit',
        condition: 'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#lint")',
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
        trigger: 'bash',
        when: 'block force push to main',
        condition: 'seq.last().args.command.includes("force") && seq.last().args.command.includes("main")',
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
      const pendingCalls = [createToolCall('bash', { command: 'git push --force origin main' })];
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
        trigger: '*',
        when: 'search wiki on error',
        condition: 'seq.lastError() !== undefined',
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
      const pendingCalls = [createToolCall('bash', { command: 'next-cmd' })];
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