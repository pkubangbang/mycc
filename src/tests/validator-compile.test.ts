/**
 * Tests for compileCondition() and ConditionValidator.validate()
 */

import { describe, it, expect } from 'vitest';
import { compileCondition, ConditionValidator } from '../hook/condition-validator.js';
import type { Condition } from '../hook/conditions.js';

describe('compileCondition()', () => {
  describe('success cases', () => {
    it('should compile valid JSON response', async () => {
      const jsonResponse = JSON.stringify({
        trigger: 'git_commit',
        condition: 'seq.has("edit_file")',
        action: { type: 'inject_before', tool: 'bash', args: { command: 'pnpm lint' } },
      });

      const result = await compileCondition(jsonResponse, 'run lint before commit', 'test-skill', 0);

      expect(result.success).toBe(true);
      expect(result.condition).toBeDefined();
      expect(result.condition?.trigger).toBe('git_commit');
      expect(result.condition?.version).toBe(1);
    });

    it('should increment version for existing conditions', async () => {
      const jsonResponse = JSON.stringify({
        trigger: 'bash',
        condition: 'true',
        action: { type: 'block' },
      });

      const result = await compileCondition(jsonResponse, 'block force push', 'test-skill', 2);

      expect(result.success).toBe(true);
      expect(result.condition?.version).toBe(3);
    });

    it('should extract JSON from markdown code block', async () => {
      const markdownResponse = '```json\n{"trigger": "*", "condition": "true", "action": {"type": "message"}}\n```';

      const result = await compileCondition(markdownResponse, 'test', 'test-skill', 0);

      expect(result.success).toBe(true);
      expect(result.condition?.trigger).toBe('*');
    });

    it('should apply defaults for missing fields', async () => {
      const jsonResponse = JSON.stringify({});

      const result = await compileCondition(jsonResponse, 'test', 'test-skill', 0);

      expect(result.success).toBe(true);
      expect(result.condition?.trigger).toBe('*');
      expect(result.condition?.condition).toBe('true');
      expect(result.condition?.action.type).toBe('message');
    });
  });

  describe('failure cases', () => {
    it('should fail when no JSON found', async () => {
      const result = await compileCondition('no json here', 'test', 'test-skill', 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No JSON');
    });

    it('should fail on invalid JSON', async () => {
      const result = await compileCondition('{ invalid json }', 'test', 'test-skill', 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('JSON parse error');
    });

    it('should fail on schema validation errors', async () => {
      const jsonResponse = JSON.stringify({
        // Missing required 'when' field - will fail because when must be non-empty string
        trigger: 'bash',
        condition: 'true',
        action: { type: 'message' },
      });

      const result = await compileCondition(jsonResponse, '', 'test-skill', 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Validation failed');
    });

    it('should fail on dangerous expression', async () => {
      const jsonResponse = JSON.stringify({
        trigger: 'bash',
        condition: 'eval("malicious")',
        action: { type: 'message' },
      });

      const result = await compileCondition(jsonResponse, 'test', 'test-skill', 0);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/not allowed|Forbidden|invalid/i);
    });

    it('should fail on expression syntax error', async () => {
      const jsonResponse = JSON.stringify({
        trigger: 'bash',
        condition: 'seq.has(', // Invalid syntax
        action: { type: 'message' },
      });

      const result = await compileCondition(jsonResponse, 'test', 'test-skill', 0);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

describe('ConditionValidator.validate()', () => {
  it('should combine schema and expression validation', () => {
    const condition: Condition = {
      trigger: 'bash',
      when: 'test',
      condition: 'seq.has("edit_file")',
      action: { type: 'message' },
      version: 1,
    };

    const result = ConditionValidator.validate(condition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should report both schema and expression errors', () => {
    const condition = {
      trigger: 123, // Schema error
      when: 'test',
      condition: 'eval("x")', // Expression error
      action: { type: 'message' },
      version: 1,
    };

    const result = ConditionValidator.validate(condition);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});