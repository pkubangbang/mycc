/**
 * Tests for condition-validator schema validation functions
 */

import { describe, it, expect } from 'vitest';
import { validateSchema, validateAction } from '../hook/condition-validator.js';
import type { Condition } from '../hook/conditions.js';

describe('validateSchema()', () => {
  describe('valid conditions', () => {
    it('should validate a minimal valid condition', () => {
      const condition: Condition = {
        trigger: 'bash',
        when: 'run lint before commit',
        condition: 'seq.has("edit_file")',
        action: { type: 'inject_before', tool: 'bash', args: { command: 'pnpm lint' } },
        version: 1,
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate condition with wildcard trigger', () => {
      const condition: Condition = {
        trigger: '*',
        when: 'any tool trigger',
        condition: 'true',
        action: { type: 'message' },
        version: 1,
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
    });

    it('should validate condition with history array', () => {
      const condition: Condition = {
        trigger: 'git_commit',
        when: 'block force push',
        condition: 'seq.last().args.command.includes("force")',
        action: { type: 'block', reason: 'Force push blocked' },
        version: 2,
        history: [{ version: 1, condition: 'seq.last().args.command.includes("--force")', action: { type: 'block', reason: 'Initial' } }],
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid conditions', () => {
    it('should reject null condition', () => {
      const result = validateSchema(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Condition must be a non-null object');
    });

    it('should reject undefined condition', () => {
      const result = validateSchema(undefined);
      expect(result.valid).toBe(false);
    });

    it('should reject non-object condition', () => {
      const result = validateSchema('string');
      expect(result.valid).toBe(false);
    });

    it('should reject missing trigger', () => {
      const condition = { when: 'test', condition: 'true', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('trigger'))).toBe(true);
    });

    it('should reject missing when field', () => {
      const condition = { trigger: 'bash', condition: 'true', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });

    it('should reject empty when field', () => {
      const condition = { trigger: 'bash', when: '', condition: 'true', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });

    it('should reject missing condition field', () => {
      const condition = { trigger: 'bash', when: 'test', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid version', () => {
      const condition: Condition = { trigger: 'bash', when: 'test', condition: 'true', action: { type: 'message' }, version: 0 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });

    it('should reject missing action', () => {
      const condition = { trigger: 'bash', when: 'test', condition: 'true', version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid history entries', () => {
      const condition: Condition = {
        trigger: 'bash', when: 'test', condition: 'true', action: { type: 'message' }, version: 2,
        history: [{ version: 1, condition: 'x', action: { type: 'message' } }, { version: 'invalid' as unknown as number, condition: 'y', action: { type: 'message' } }],
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });
  });

  describe('warnings', () => {
    it('should accept any non-empty trigger (LLM decides validity)', () => {
      const condition: Condition = { trigger: 'unknown_tool_xyz', when: 'test', condition: 'true', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should warn about empty trigger', () => {
      const condition: Condition = { trigger: '', when: 'test', condition: 'true', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.warnings.some(w => w.includes('trigger'))).toBe(true);
    });

    it('should warn about empty condition', () => {
      const condition: Condition = { trigger: 'bash', when: 'test', condition: '', action: { type: 'message' }, version: 1 };
      const result = validateSchema(condition);
      expect(result.warnings.some(w => w.includes('condition'))).toBe(true);
    });
  });
});

describe('validateAction()', () => {
  it('should validate inject_before action', () => {
    const action = { type: 'inject_before', tool: 'bash', args: { command: 'pnpm lint' } };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });

  it('should reject inject_before without tool', () => {
    const action = { type: 'inject_before', args: { command: 'lint' } };
    const result = validateAction(action);
    expect(result.valid).toBe(false);
  });

  it('should reject inject_before without args', () => {
    const action = { type: 'inject_before', tool: 'bash' };
    const result = validateAction(action);
    expect(result.valid).toBe(false);
  });

  it('should warn about out-of-range timeout', () => {
    const action = { type: 'inject_before', tool: 'bash', args: { command: 'lint', timeout: 500 } };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes('timeout'))).toBe(true);
  });

  it('should validate block action', () => {
    const action = { type: 'block', reason: 'No force push' };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });

  it('should validate block without reason', () => {
    const action = { type: 'block' };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });

  it('should reject block with non-string reason', () => {
    const action = { type: 'block', reason: 123 };
    const result = validateAction(action);
    expect(result.valid).toBe(false);
  });

  it('should validate message action', () => {
    const action = { type: 'message' };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });

  it('should reject unknown action type', () => {
    const action = { type: 'unknown_action' };
    const result = validateAction(action);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('unknown_action'))).toBe(true);
  });

  it('should reject null action', () => {
    const result = validateAction(null);
    expect(result.valid).toBe(false);
  });

  it('should reject action without type', () => {
    const action = { tool: 'bash' };
    const result = validateAction(action);
    expect(result.valid).toBe(false);
  });
});