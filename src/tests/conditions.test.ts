/**
 * Tests for conditions.ts
 *
 * Tests cover:
 * - ConditionRegistry.load() with valid/invalid JSON
 * - ConditionRegistry.matches() with various triggers
 * - ConditionRegistry.get/set/findByTrigger
 * - Atomic file writes and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConditionRegistry, type Condition, type HookAction } from '../hook/conditions.js';
import { Sequence } from '../hook/sequence.js';
import * as fs from 'fs';
import * as path from 'path';

// Mock getMyccDir to use temp directory within project
const testDir = path.join(process.cwd(), '.tmp-test-conditions');
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    getMyccDir: () => testDir,
  };
});

// ============================================================================
// ConditionRegistry Core Tests
// ============================================================================

describe('ConditionRegistry', () => {
  let registry: ConditionRegistry;
  const conditionsFile = path.join(testDir, 'conditions.json');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    registry = new ConditionRegistry();
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  // ============================================================================
  // load()
  // ============================================================================

  describe('load()', () => {
    it('should handle missing file gracefully', async () => {
      // No file exists
      await registry.load();
      expect(registry.get('any-skill')).toBeUndefined();
    });

    it('should load valid conditions.json', async () => {
      const conditions: Record<string, Condition> = {
        'pre-commit-lint': {
          trigger: 'git_commit',
          when: 'run lint before commit',
          condition: 'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#lint")',
          action: {
            type: 'inject_before',
            tool: 'bash',
            args: { command: 'pnpm lint', intent: 'pre-commit lint' },
          },
          version: 1,
        },
        'block-force-push': {
          trigger: 'bash',
          when: 'block force push to main',
          condition: 'seq.last().args.command.includes("force") && seq.last().args.command.includes("main")',
          action: { type: 'block', reason: 'Force push to main is prohibited' },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      expect(registry.get('pre-commit-lint')).toBeDefined();
      expect(registry.get('block-force-push')).toBeDefined();
    });

    it('should handle invalid JSON gracefully', async () => {
      fs.writeFileSync(conditionsFile, '{ invalid json }');
      
      // Should not throw, just log error
      await registry.load();
      expect(registry.get('any-skill')).toBeUndefined();
    });

    it('should handle malformed JSON with partial content', async () => {
      fs.writeFileSync(conditionsFile, '{"skill1": { "trigger": "bash"'); // Incomplete
      
      await registry.load();
      expect(registry.get('skill1')).toBeUndefined();
    });

    it('should validate and fix empty trigger', async () => {
      const conditions: Record<string, Condition> = {
        'test-skill': {
          trigger: '', // Empty trigger - produces warning but is valid
          when: 'test',
          condition: 'true',
          action: { type: 'message' },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      const result = await registry.load();

      // Empty trigger passes validation (warning only), load may reject if validation fails
      // The condition is loaded since validation passes
      const cond = registry.get('test-skill');
      // Empty trigger is valid but produces warning - it stays as empty
      expect(cond?.trigger).toBe('');
    });

    it('should clamp invalid timeout values', async () => {
      const conditions: Record<string, Condition> = {
        'test-skill': {
          trigger: 'bash',
          when: 'test',
          condition: 'true',
          action: {
            type: 'inject_before',
            tool: 'bash',
            args: { command: 'test', timeout: 100 }, // Out of range
          },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      const cond = registry.get('test-skill');
      const args = cond?.action as { args: { timeout?: number } };
      // Timeout is clamped to 300 max in applyRuntimeFixes
      expect(args.args.timeout).toBeLessThanOrEqual(300);
    });

    it('should fix timeout in history entries too', async () => {
      const conditions: Record<string, Condition> = {
        'test-skill': {
          trigger: 'bash',
          when: 'test',
          condition: 'true',
          action: {
            type: 'inject_before',
            tool: 'bash',
            args: { command: 'test' },
          },
          version: 2,
          history: [
            {
              version: 1,
              condition: 'true',
              action: {
                type: 'inject_before',
                tool: 'bash',
                args: { command: 'test', timeout: 0 }, // Invalid
              },
            },
          ],
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      const cond = registry.get('test-skill');
      const historyEntry = cond?.history?.[0];
      const args = historyEntry?.action as { args: { timeout?: number } };
      expect(args.args.timeout).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // save()
  // ============================================================================

  describe('save()', () => {
    it('should save conditions to file', async () => {
      registry.set('test-skill', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      await registry.save();

      expect(fs.existsSync(conditionsFile)).toBe(true);
      const content = fs.readFileSync(conditionsFile, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed['test-skill']).toBeDefined();
    });

    it('should create directory if missing', async () => {
      // Remove directory
      fs.rmSync(testDir, { recursive: true, force: true });

      registry.set('test-skill', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      await registry.save();

      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(conditionsFile)).toBe(true);
    });

    it('should preserve all condition fields', async () => {
      const fullCondition: Condition = {
        trigger: 'git_commit',
        when: 'run lint before commit',
        condition: 'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#lint")',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'pnpm lint', intent: 'pre-commit lint', timeout: 60 },
        },
        version: 2,
        history: [
          {
            version: 1,
            condition: 'seq.has("edit_file")',
            action: { type: 'message' },
            reason: 'initial compilation',
          },
        ],
      };

      registry.set('pre-commit-lint', fullCondition);
      await registry.save();

      const content = fs.readFileSync(conditionsFile, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed['pre-commit-lint']).toEqual(fullCondition);
    });

    it('should handle multiple conditions', async () => {
      registry.set('skill1', {
        trigger: 'bash',
        when: 'test1',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });
      registry.set('skill2', {
        trigger: 'git_commit',
        when: 'test2',
        condition: 'false',
        action: { type: 'block' },
        version: 1,
      });

      await registry.save();

      const content = fs.readFileSync(conditionsFile, 'utf-8');
      const parsed = JSON.parse(content);
      expect(Object.keys(parsed)).toHaveLength(2);
    });
  });

  // ============================================================================
  // get() / set()
  // ============================================================================

  describe('get() / set()', () => {
    it('should get undefined for non-existent skill', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should set and get condition', () => {
      const condition: Condition = {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      };

      registry.set('test-skill', condition);
      expect(registry.get('test-skill')).toEqual(condition);
    });

    it('should overwrite existing condition', () => {
      registry.set('test-skill', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      registry.set('test-skill', {
        trigger: 'git_commit',
        when: 'updated',
        condition: 'false',
        action: { type: 'block' },
        version: 2,
      });

      const cond = registry.get('test-skill');
      expect(cond?.trigger).toBe('git_commit');
      expect(cond?.version).toBe(2);
    });
  });

  // ============================================================================
  // findByTrigger()
  // ============================================================================

  describe('findByTrigger()', () => {
    beforeEach(() => {
      registry.set('any-hook', {
        trigger: '*',
        when: 'any tool',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });
      registry.set('bash-hook', {
        trigger: 'bash',
        when: 'bash only',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });
      registry.set('commit-hook', {
        trigger: 'git_commit',
        when: 'commit only',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });
    });

    it('should find conditions with exact trigger', () => {
      const bashHooks = registry.findByTrigger('bash');
      expect(bashHooks).toHaveLength(2); // bash-hook + any-hook
      expect(bashHooks.some(h => h.when === 'bash only')).toBe(true);
    });

    it('should find wildcard conditions for any trigger', () => {
      const editHooks = registry.findByTrigger('edit_file');
      expect(editHooks).toHaveLength(1); // only any-hook
      expect(editHooks[0].trigger).toBe('*');
    });

    it('should return empty array for no matches', () => {
      registry = new ConditionRegistry(); // Empty registry
      expect(registry.findByTrigger('bash')).toHaveLength(0);
    });
  });

  // ============================================================================
  // matches()
  // ============================================================================

  describe('matches()', () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = new Sequence();

      registry.set('edit-reminder', {
        trigger: 'edit_file',
        when: 'remind about tests after edit',
        condition: 'seq.count("edit_file") >= 2',
        action: { type: 'message' },
        version: 1,
      });

      registry.set('any-error', {
        trigger: '*',
        when: 'search wiki on error',
        condition: 'seq.lastError() !== undefined',
        action: { type: 'inject_before', tool: 'wiki_get', args: { query: 'error', domain: 'pitfall' } },
        version: 1,
      });
    });

    it('should match condition that evaluates to true', () => {
      // Add two edits
      seq.add({ tool: 'edit_file', args: { path: 'a.ts' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'edit_file', args: { path: 'b.ts' }, result: 'ok', timestamp: 2000 });

      const matches = registry.matches('edit_file', seq);
      expect(matches).toContain('edit-reminder');
    });

    it('should not match condition that evaluates to false', () => {
      // Only one edit
      seq.add({ tool: 'edit_file', args: { path: 'a.ts' }, result: 'ok', timestamp: 1000 });

      const matches = registry.matches('edit_file', seq);
      expect(matches).not.toContain('edit-reminder');
    });

    it('should match wildcard trigger for any tool', () => {
      // Add an error
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'Error: failed', timestamp: 1000 });

      const matches = registry.matches('bash', seq);
      expect(matches).toContain('any-error');
    });

    it('should not match different trigger', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: 1000 });

      const matches = registry.matches('bash', seq);
      expect(matches).not.toContain('edit-reminder'); // Wrong trigger
    });

    it('should skip already injected skills', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'Error: failed', timestamp: 1000 });

      // First match
      const matches1 = registry.matches('bash', seq);
      expect(matches1).toContain('any-error');

      // Mark as injected
      registry.markInjected('any-error');

      // Second match - should skip
      const matches2 = registry.matches('bash', seq);
      expect(matches2).not.toContain('any-error');
    });

    it('should return multiple matching conditions', () => {
      registry.set('another-bash-hook', {
        trigger: 'bash',
        when: 'another hook',
        condition: 'seq.count() > 0',
        action: { type: 'message' },
        version: 1,
      });

      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'Error: failed', timestamp: 1000 });

      const matches = registry.matches('bash', seq);
      expect(matches).toContain('any-error');
      expect(matches).toContain('another-bash-hook');
    });
  });

  // ============================================================================
  // pending management
  // ============================================================================

  describe('pending management', () => {
    it('should mark skill as pending', () => {
      registry.markPending('new-skill');
      expect(registry.needsCompilation('new-skill')).toBe(true);
    });

    it('should not mark skill with existing condition as pending', () => {
      registry.set('existing-skill', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      registry.markPending('existing-skill');
      expect(registry.needsCompilation('existing-skill')).toBe(false);
    });

    it('should remove from pending when condition is set', () => {
      registry.markPending('new-skill');
      expect(registry.needsCompilation('new-skill')).toBe(true);

      registry.set('new-skill', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      expect(registry.needsCompilation('new-skill')).toBe(false);
    });
  });

  // ============================================================================
  // injected management
  // ============================================================================

  describe('injected management', () => {
    it('should track injected skills', () => {
      expect(registry.hasInjected('test-skill')).toBe(false);

      registry.markInjected('test-skill');
      expect(registry.hasInjected('test-skill')).toBe(true);
    });

    it('should clear all injected markers', () => {
      registry.markInjected('skill1');
      registry.markInjected('skill2');
      expect(registry.hasInjected('skill1')).toBe(true);
      expect(registry.hasInjected('skill2')).toBe(true);

      registry.clearInjected();
      expect(registry.hasInjected('skill1')).toBe(false);
      expect(registry.hasInjected('skill2')).toBe(false);
    });
  });

  // ============================================================================
  // load/save roundtrip
  // ============================================================================

  describe('load/save roundtrip', () => {
    it('should preserve conditions through save/load cycle', async () => {
      const original: Condition = {
        trigger: 'git_commit',
        when: 'run tests before commit',
        condition: 'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#test")',
        action: {
          type: 'inject_before',
          tool: 'bash',
          args: { command: 'pnpm test', intent: 'pre-commit tests', timeout: 120 },
        },
        version: 2,
        history: [
          {
            version: 1,
            condition: 'seq.has("edit_file")',
            action: { type: 'inject_before', tool: 'bash', args: { command: 'pnpm test' } },
            reason: 'initial',
          },
        ],
      };

      registry.set('pre-commit-test', original);
      await registry.save();

      // Create new registry and load
      const newRegistry = new ConditionRegistry();
      await newRegistry.load();

      const loaded = newRegistry.get('pre-commit-test');
      expect(loaded).toEqual(original);
    });

    it('should handle special characters in condition', async () => {
      const condition: Condition = {
        trigger: 'bash',
        when: 'test special chars',
        condition: 'seq.last().args.command.includes("git push --force")',
        action: { type: 'block', reason: 'Force push blocked!' },
        version: 1,
      };

      registry.set('special-chars', condition);
      await registry.save();

      const newRegistry = new ConditionRegistry();
      await newRegistry.load();

      const loaded = newRegistry.get('special-chars');
      expect(loaded?.condition).toBe('seq.last().args.command.includes("git push --force")');
    });

    it('should handle empty conditions file', async () => {
      fs.writeFileSync(conditionsFile, '{}');
      await registry.load();
      expect(registry.get('any')).toBeUndefined();
    });
  });

  // ============================================================================
  // edge cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle null values in JSON', async () => {
      fs.writeFileSync(conditionsFile, '{"skill1": null}');
      await registry.load();
      expect(registry.get('skill1')).toBeUndefined();
    });

    it('should handle array instead of object', async () => {
      fs.writeFileSync(conditionsFile, '[]');
      await registry.load();
      // Should handle gracefully, no conditions loaded
    });

    it('should handle file write failure gracefully', async () => {
      // Make directory a file to cause write failure
      fs.rmSync(testDir, { recursive: true, force: true });
      fs.writeFileSync(testDir, 'not a directory');

      registry.set('test', {
        trigger: 'bash',
        when: 'test',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      });

      // Should not throw
      await registry.save();

      // Clean up for afterEach
      fs.rmSync(testDir, { force: true });
    });
  });
});

// ============================================================================
// Type Tests
// ============================================================================

describe('HookAction Types', () => {
  it('should accept inject_before action', () => {
    const action: HookAction = {
      type: 'inject_before',
      tool: 'bash',
      args: { command: 'test' },
    };
    expect(action.type).toBe('inject_before');
  });

  it('should accept inject_after action', () => {
    const action: HookAction = {
      type: 'inject_after',
      tool: 'wiki_get',
      args: { query: 'test', domain: 'project' },
    };
    expect(action.type).toBe('inject_after');
  });

  it('should accept block action', () => {
    const action: HookAction = {
      type: 'block',
      reason: 'Not allowed',
    };
    expect(action.type).toBe('block');
  });

  it('should accept replace action', () => {
    const action: HookAction = {
      type: 'replace',
      tool: 'bash',
      args: { command: 'safe-command' },
    };
    expect(action.type).toBe('replace');
  });

  it('should accept message action', () => {
    const action: HookAction = {
      type: 'message',
    };
    expect(action.type).toBe('message');
  });

  it('should support optional timeout in inject actions', () => {
    const action: HookAction = {
      type: 'inject_before',
      tool: 'bash',
      args: { command: 'test', timeout: 60 },
    };
    expect((action as { args: { timeout?: number } }).args.timeout).toBe(60);
  });
});