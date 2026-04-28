/**
 * Tests for expression validation and testing functions
 */

import { describe, it, expect } from 'vitest';
import {
  validateExpression,
  testCondition,
  smokeTestExpression,
  createMockSequence,
} from '../hook/condition-validator.js';
import type { TestableSequence } from '../hook/condition-validator.js';

describe('validateExpression()', () => {
  describe('valid expressions', () => {
    it('should accept seq.has()', () => {
      const result = validateExpression('seq.has("bash")');
      expect(result.valid).toBe(true);
    });

    it('should accept seq.hasAny()', () => {
      const result = validateExpression('seq.hasAny(["bash", "edit_file"])');
      expect(result.valid).toBe(true);
    });

    it('should accept complex boolean expressions', () => {
      const result = validateExpression('seq.has("edit_file") && !seq.hasCommand("bash#lint")');
      expect(result.valid).toBe(true);
    });

    it('should accept literal true/false', () => {
      expect(validateExpression('true').valid).toBe(true);
      expect(validateExpression('false').valid).toBe(true);
    });

    it('should accept empty expression', () => {
      const result = validateExpression('');
      expect(result.valid).toBe(true);
    });
  });

  describe('dangerous patterns', () => {
    it('should reject eval()', () => {
      const result = validateExpression('eval("malicious")');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not allowed') || e.includes('Forbidden'))).toBe(true);
    });

    it('should reject Function constructor', () => {
      const result = validateExpression('Function("return 1")');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject require()', () => {
      const result = validateExpression('require("fs")');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject process access', () => {
      const result = validateExpression('process.exit()');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject fs access', () => {
      const result = validateExpression('fs.readFileSync()');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject __proto__', () => {
      const result = validateExpression('obj.__proto__');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject constructor', () => {
      const result = validateExpression('obj.constructor()');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('syntax errors', () => {
    it('should reject unbalanced parentheses', () => {
      const result = validateExpression('seq.has("bash"');
      expect(result.valid).toBe(false);
    });

    it('should reject unbalanced brackets', () => {
      const result = validateExpression('seq.hasAny(["bash"');
      expect(result.valid).toBe(false);
    });
  });

  describe('warnings', () => {
    it('should warn about === comparison', () => {
      const result = validateExpression('seq.has("bash") === true');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('==='))).toBe(true);
    });
  });
});

describe('testCondition()', () => {
  describe('with mock sequence', () => {
    it('should evaluate valid expression', () => {
      const mockSeq = createMockSequence([
        { tool: 'bash', args: { command: 'test' }, result: 'ok' },
      ]);
      const result = testCondition('seq.has("bash")', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });

    it('should return false for non-matching condition', () => {
      const mockSeq = createMockSequence([]);
      const result = testCondition('seq.has("bash")', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(false);
    });

    it('should handle syntax errors', () => {
      const mockSeq = createMockSequence([]);
      const result = testCondition('seq.has(', mockSeq);
      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should evaluate hasAny()', () => {
      const mockSeq = createMockSequence([
        { tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok' },
      ]);
      const result = testCondition('seq.hasAny(["bash", "edit_file"])', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });

    it('should evaluate hasCommand()', () => {
      const mockSeq = createMockSequence([
        { tool: 'bash', args: { command: 'pnpm lint' }, result: 'ok' },
      ]);
      const result = testCondition('seq.hasCommand("bash#lint")', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });

    it('should evaluate count()', () => {
      const mockSeq = createMockSequence([
        { tool: 'bash', args: {}, result: 'ok' },
        { tool: 'bash', args: {}, result: 'ok' },
        { tool: 'edit_file', args: {}, result: 'ok' },
      ]);
      const result = testCondition('seq.count("bash") == 2', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });
  });
});

describe('smokeTestExpression()', () => {
  it('should pass for valid expression', () => {
    const result = smokeTestExpression('seq.has("bash")');
    expect(result.passed).toBe(true);
  });

  it('should fail for syntax error', () => {
    const result = smokeTestExpression('seq.has(');
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('createMockSequence()', () => {
  it('should create empty sequence', () => {
    const seq = createMockSequence([]);
    expect(seq.has('bash')).toBe(false);
    expect(seq.count()).toBe(0);
  });

  it('should track events', () => {
    const seq = createMockSequence([
      { tool: 'bash', args: { command: 'test' }, result: 'ok' },
    ]);
    expect(seq.has('bash')).toBe(true);
  });

  it('should support hasAny()', () => {
    const seq = createMockSequence([
      { tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok' },
    ]);
    expect(seq.hasAny(['bash', 'edit_file'])).toBe(true);
    expect(seq.hasAny(['bash', 'write_file'])).toBe(false);
  });

  it('should support hasCommand()', () => {
    const seq = createMockSequence([
      { tool: 'bash', args: { command: 'pnpm lint' }, result: 'ok' },
    ]);
    expect(seq.hasCommand('bash#lint')).toBe(true);
    expect(seq.hasCommand('bash#test')).toBe(false);
  });

  it('should support last()', () => {
    const emptySeq = createMockSequence([]);
    expect(emptySeq.last()).toBeUndefined();

    const seq = createMockSequence([
      { tool: 'bash', args: { command: 'first' }, result: 'ok' },
      { tool: 'edit_file', args: { path: 'test' }, result: 'ok' },
    ]);
    const lastEvent = seq.last() as { tool: string };
    expect(lastEvent.tool).toBe('edit_file');
  });

  it('should support count()', () => {
    const seq = createMockSequence([
      { tool: 'bash', args: {}, result: 'ok' },
      { tool: 'bash', args: {}, result: 'ok' },
      { tool: 'edit_file', args: {}, result: 'ok' },
    ]);
    expect(seq.count('bash')).toBe(2);
    expect(seq.count()).toBe(3);
  });
});