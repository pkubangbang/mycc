/**
 * Tests for sequence.ts
 *
 * Tests cover:
 * - Sequence.evaluate() with various expressions
 * - All seq.X functions (has, hasAny, hasCommand, last, lastError, count, since, sinceEdit)
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Sequence, type SequenceEvent } from '../context/shared/sequence.js';

// ============================================================================
// Sequence Basic Operations
// ============================================================================

describe('Sequence', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  describe('add() and getEvents()', () => {
    it('should add events to sequence', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
      expect(seq.getEvents()).toHaveLength(1);
    });

    it('should return copy of events array', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
      const events = seq.getEvents();
      events.push({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
      expect(seq.getEvents()).toHaveLength(1); // Original unchanged
    });
  });

  describe('clear()', () => {
    it('should clear all events', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
      seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
      expect(seq.getEvents()).toHaveLength(2);

      seq.clear();
      expect(seq.getEvents()).toHaveLength(0);
    });
  });
});

// ============================================================================
// seq.has()
// ============================================================================

describe('seq.has()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return false for empty sequence', () => {
    expect(seq.has('bash')).toBe(false);
  });

  it('should return true for existing tool', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.has('bash')).toBe(true);
  });

  it('should return false for non-existent tool', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.has('edit_file')).toBe(false);
  });

  it('should find tool among multiple events', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'read_file', args: { path: 'test.ts' }, result: 'ok', timestamp: Date.now() });

    expect(seq.has('bash')).toBe(true);
    expect(seq.has('edit_file')).toBe(true);
    expect(seq.has('read_file')).toBe(true);
    expect(seq.has('write_file')).toBe(false);
  });
});

// ============================================================================
// seq.hasAny()
// ============================================================================

describe('seq.hasAny()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return false for empty sequence', () => {
    expect(seq.hasAny(['bash', 'edit_file'])).toBe(false);
  });

  it('should return true if any tool exists', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.hasAny(['bash', 'edit_file'])).toBe(true);
  });

  it('should return true if second tool exists', () => {
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.hasAny(['bash', 'edit_file'])).toBe(true);
  });

  it('should return false if none exist', () => {
    seq.add({ tool: 'read_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.hasAny(['bash', 'edit_file'])).toBe(false);
  });

  it('should handle empty array', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.hasAny([])).toBe(false);
  });
});

// ============================================================================
// seq.hasCommand()
// ============================================================================

describe('seq.hasCommand()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  describe('bash#pattern syntax', () => {
    it('should find command containing pattern', () => {
      seq.add({
        tool: 'bash',
        args: { command: 'pnpm lint', intent: 'lint' },
        result: 'ok',
        timestamp: Date.now(),
      });
      expect(seq.hasCommand('bash#lint')).toBe(true);
      expect(seq.hasCommand('bash#pnpm')).toBe(true);
      expect(seq.hasCommand('bash#test')).toBe(false);
    });

    it('should handle partial pattern matches', () => {
      seq.add({
        tool: 'bash',
        args: { command: 'git commit -m "message"', intent: 'commit' },
        result: 'ok',
        timestamp: Date.now(),
      });
      expect(seq.hasCommand('bash#git commit')).toBe(true);
      expect(seq.hasCommand('bash#-m')).toBe(true);
    });

    it('should not match non-bash tools', () => {
      seq.add({
        tool: 'edit_file',
        args: { path: 'lint.ts' },
        result: 'ok',
        timestamp: Date.now(),
      });
      expect(seq.hasCommand('bash#lint')).toBe(false);
    });
  });

  describe('regular tool check', () => {
    it('should work like has() without #', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
      expect(seq.hasCommand('bash')).toBe(true);
      expect(seq.hasCommand('edit_file')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle command that is not a string', () => {
      seq.add({
        tool: 'bash',
        args: { command: 123 }, // Invalid type
        result: 'ok',
        timestamp: Date.now(),
      });
      expect(seq.hasCommand('bash#test')).toBe(false);
    });

    it('should handle missing command arg', () => {
      seq.add({
        tool: 'bash',
        args: { intent: 'test' }, // No command
        result: 'ok',
        timestamp: Date.now(),
      });
      expect(seq.hasCommand('bash#test')).toBe(false);
    });
  });
});

// ============================================================================
// seq.last()
// ============================================================================

describe('seq.last()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return undefined for empty sequence', () => {
    expect(seq.last()).toBeUndefined();
  });

  it('should return last event without filter', () => {
    seq.add({ tool: 'bash', args: { command: 'first' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: Date.now() });

    const last = seq.last();
    expect(last?.tool).toBe('edit_file');
  });

  it('should return last event matching tool', () => {
    seq.add({ tool: 'bash', args: { command: 'first' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'bash', args: { command: 'second' }, result: 'ok', timestamp: Date.now() });

    const lastBash = seq.last('bash');
    expect(lastBash?.args.command).toBe('second');
  });

  it('should return undefined for non-existent tool filter', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.last('edit_file')).toBeUndefined();
  });

  it('should return the most recent when multiple matches exist', () => {
    seq.add({ tool: 'bash', args: { command: 'first' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'bash', args: { command: 'second' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'bash', args: { command: 'third' }, result: 'ok', timestamp: 3000 });

    const last = seq.last('bash');
    expect(last?.args.command).toBe('third');
  });
});

// ============================================================================
// seq.lastError()
// ============================================================================

describe('seq.lastError()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return undefined for empty sequence', () => {
    expect(seq.lastError()).toBeUndefined();
  });

  it('should return undefined when no error events', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
    expect(seq.lastError()).toBeUndefined();
  });

  it('should find error event', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    seq.add({
      tool: 'bash',
      args: { command: 'fail' },
      result: 'Error: Command failed',
      timestamp: Date.now(),
    });

    const err = seq.lastError();
    expect(err).toBeDefined();
    expect(err?.tool).toBe('bash');
    expect(err?.message).toContain('Error');
  });

  it('should find event with "failed" in result', () => {
    seq.add({
      tool: 'bash',
      args: { command: 'test' },
      result: 'Process failed with exit code 1',
      timestamp: Date.now(),
    });

    const err = seq.lastError();
    expect(err).toBeDefined();
    expect(err?.result).toContain('failed');
  });

  it('should return most recent error', () => {
    seq.add({
      tool: 'bash',
      args: { command: 'first' },
      result: 'Error: first error',
      timestamp: 1000,
    });
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: 2000 });
    seq.add({
      tool: 'bash',
      args: { command: 'second' },
      result: 'Error: second error',
      timestamp: 3000,
    });

    const err = seq.lastError();
    expect(err?.result).toContain('second error');
  });

  it('should include message field for convenience', () => {
    seq.add({
      tool: 'bash',
      args: { command: 'test' },
      result: 'Error: test failed',
      timestamp: Date.now(),
    });

    const err = seq.lastError();
    expect(err?.message).toBe('Error: test failed');
  });
});

// ============================================================================
// seq.count()
// ============================================================================

describe('seq.count()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return 0 for empty sequence', () => {
    expect(seq.count()).toBe(0);
    expect(seq.count('bash')).toBe(0);
  });

  it('should count all events without filter', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'read_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });

    expect(seq.count()).toBe(3);
  });

  it('should count specific tool', () => {
    seq.add({ tool: 'bash', args: { command: 'test1' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'bash', args: { command: 'test2' }, result: 'ok', timestamp: Date.now() });
    seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });

    expect(seq.count('bash')).toBe(2);
    expect(seq.count('edit_file')).toBe(1);
    expect(seq.count('read_file')).toBe(0);
  });
});

// ============================================================================
// seq.since()
// ============================================================================

describe('seq.since()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return empty array for empty sequence', () => {
    expect(seq.since('bash')).toEqual([]);
  });

  it('should return all events if tool not found', () => {
    seq.add({ tool: 'edit_file', args: { path: 'a' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'edit_file', args: { path: 'b' }, result: 'ok', timestamp: 2000 });

    const events = seq.since('bash');
    expect(events).toHaveLength(2);
  });

  it('should return events after last occurrence', () => {
    seq.add({ tool: 'bash', args: { command: 'first' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'edit_file', args: { path: 'a' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'edit_file', args: { path: 'b' }, result: 'ok', timestamp: 3000 });

    const events = seq.since('bash');
    expect(events).toHaveLength(2);
    expect(events[0].tool).toBe('edit_file');
  });

  it('should return empty array if tool is last event', () => {
    seq.add({ tool: 'edit_file', args: { path: 'a' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: 2000 });

    const events = seq.since('bash');
    expect(events).toHaveLength(0);
  });

  it('should use last occurrence when tool appears multiple times', () => {
    seq.add({ tool: 'bash', args: { command: 'first' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'edit_file', args: { path: 'a' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'bash', args: { command: 'second' }, result: 'ok', timestamp: 3000 });
    seq.add({ tool: 'edit_file', args: { path: 'b' }, result: 'ok', timestamp: 4000 });

    const events = seq.since('bash');
    expect(events).toHaveLength(1);
    expect(events[0].args.path).toBe('b');
  });
});

// ============================================================================
// seq.sinceEdit()
// ============================================================================

describe('seq.sinceEdit()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it('should return empty array for empty sequence', () => {
    expect(seq.sinceEdit()).toEqual([]);
  });

  it('should return all events if no edits found', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'read_file', args: { path: 'test' }, result: 'ok', timestamp: 2000 });

    const events = seq.sinceEdit();
    expect(events).toHaveLength(2);
  });

  it('should return events after edit_file', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'read_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 3000 });

    const events = seq.sinceEdit();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('read_file');
  });

  it('should return events after write_file', () => {
    seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'write_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'read_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 3000 });

    const events = seq.sinceEdit();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('read_file');
  });

  it('should use most recent edit', () => {
    seq.add({ tool: 'edit_file', args: { path: 'a.ts' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'bash', args: { command: 'lint' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'edit_file', args: { path: 'b.ts' }, result: 'ok', timestamp: 3000 });
    seq.add({ tool: 'read_file', args: { path: 'c.ts' }, result: 'ok', timestamp: 4000 });

    const events = seq.sinceEdit();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('read_file');
  });
});

// ============================================================================
// Sequence.evaluate()
// ============================================================================

describe('Sequence.evaluate()', () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  describe('seq.has()', () => {
    it('should evaluate seq.has() expression', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });

      expect(seq.evaluate('seq.has("bash")')).toBe(true);
      expect(seq.evaluate('seq.has("edit_file")')).toBe(false);
    });
  });

  describe('seq.hasAny()', () => {
    it('should evaluate seq.hasAny() expression', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });

      expect(seq.evaluate('seq.hasAny(["bash", "edit_file"])')).toBe(true);
      expect(seq.evaluate('seq.hasAny(["edit_file", "write_file"])')).toBe(false);
    });
  });

  describe('seq.hasCommand()', () => {
    it('should evaluate seq.hasCommand() expression', () => {
      seq.add({
        tool: 'bash',
        args: { command: 'pnpm lint' },
        result: 'ok',
        timestamp: Date.now(),
      });

      expect(seq.evaluate('seq.hasCommand("bash#lint")')).toBe(true);
      expect(seq.evaluate('seq.hasCommand("bash#test")')).toBe(false);
    });
  });

  describe('seq.last()', () => {
    it('should evaluate seq.last() expression', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });

      expect(seq.evaluate('seq.last().tool === "bash"')).toBe(true);
    });

    it('should handle undefined last()', () => {
      // Empty sequence, last() returns undefined
      // Comparing undefined === "bash" is false
      expect(seq.evaluate('seq.last()?.tool === "bash"')).toBe(false);
    });
  });

  describe('seq.lastError()', () => {
    it('should evaluate seq.lastError() expression', () => {
      seq.add({
        tool: 'bash',
        args: { command: 'test' },
        result: 'Error: failed',
        timestamp: Date.now(),
      });

      expect(seq.evaluate('seq.lastError() !== undefined')).toBe(true);
    });

    it('should return false when no error', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });

      expect(seq.evaluate('seq.lastError() !== undefined')).toBe(false);
    });
  });

  describe('seq.count()', () => {
    it('should evaluate seq.count() expression', () => {
      seq.add({ tool: 'bash', args: { command: 'test1' }, result: 'ok', timestamp: Date.now() });
      seq.add({ tool: 'bash', args: { command: 'test2' }, result: 'ok', timestamp: Date.now() });
      seq.add({ tool: 'bash', args: { command: 'test3' }, result: 'ok', timestamp: Date.now() });

      expect(seq.evaluate('seq.count("bash") === 3')).toBe(true);
      expect(seq.evaluate('seq.count("bash") > 2')).toBe(true);
      expect(seq.evaluate('seq.count() === 3')).toBe(true);
    });
  });

  describe('seq.since()', () => {
    it('should evaluate seq.since() expression', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'edit_file', args: { path: 'a' }, result: 'ok', timestamp: 2000 });
      seq.add({ tool: 'edit_file', args: { path: 'b' }, result: 'ok', timestamp: 3000 });

      expect(seq.evaluate('seq.since("bash").length === 2')).toBe(true);
    });
  });

  describe('seq.sinceEdit()', () => {
    it('should evaluate seq.sinceEdit() expression', () => {
      seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'bash', args: { command: 'lint' }, result: 'ok', timestamp: 2000 });

      expect(seq.evaluate('seq.sinceEdit().length === 1')).toBe(true);
    });
  });

  describe('complex expressions', () => {
    it('should evaluate boolean AND', () => {
      seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });
      seq.add({ tool: 'bash', args: { command: 'pnpm lint' }, result: 'ok', timestamp: Date.now() });

      expect(
        seq.evaluate('seq.has("edit_file") && seq.hasCommand("bash#lint")')
      ).toBe(true);
    });

    it('should evaluate boolean OR', () => {
      seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });

      expect(
        seq.evaluate('seq.has("edit_file") || seq.has("write_file")')
      ).toBe(true);
    });

    it('should evaluate negation', () => {
      seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: Date.now() });

      expect(seq.evaluate('!seq.hasCommand("bash#lint")')).toBe(true);
    });

    it('should evaluate complex condition', () => {
      seq.add({ tool: 'edit_file', args: { path: 'test' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'bash', args: { command: 'pnpm test' }, result: 'ok', timestamp: 2000 });

      const expr = 'seq.has("edit_file") && !seq.hasCommand("bash#lint") && seq.count("bash") >= 1';
      expect(seq.evaluate(expr)).toBe(true);
    });
  });

  describe('literal values', () => {
    it('should evaluate true', () => {
      expect(seq.evaluate('true')).toBe(true);
    });

    it('should evaluate false', () => {
      expect(seq.evaluate('false')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should return false on syntax error', () => {
      // Invalid syntax - will throw internally but return false
      expect(seq.evaluate('seq.has(')).toBe(false);
    });

    it('should return false on undefined function', () => {
      expect(seq.evaluate('seq.nonexistent()')).toBe(false);
    });

    it('should return false on type error', () => {
      seq.add({ tool: 'bash', args: { command: 'test' }, result: 'ok', timestamp: Date.now() });
      // Type errors cause evaluation to fail and return false
      expect(seq.evaluate('seq.last().args.command.foo')).toBe(false);
    });
  });
});

// ============================================================================
// hasSkillInConversation()
// ============================================================================

describe('Sequence.hasSkillInConversation()', () => {
  it('should return false without triologue', () => {
    const seq = new Sequence();
    expect(seq.hasSkillInConversation('test-skill')).toBe(false);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Sequence Integration Tests', () => {
  it('should support realistic pre-commit hook scenario', () => {
    const seq = new Sequence();

    // User edits some files
    seq.add({ tool: 'edit_file', args: { path: 'src/test.ts' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'edit_file', args: { path: 'src/util.ts' }, result: 'ok', timestamp: 2000 });

    // Condition: files edited and no lint run yet
    const shouldLint = seq.evaluate(
      'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#lint")'
    );
    expect(shouldLint).toBe(true);

    // Run lint
    seq.add({ tool: 'bash', args: { command: 'pnpm lint' }, result: 'ok', timestamp: 3000 });

    // Now condition should be false
    const shouldLintNow = seq.evaluate(
      'seq.hasAny(["edit_file", "write_file"]) && !seq.hasCommand("bash#lint")'
    );
    expect(shouldLintNow).toBe(false);
  });

  it('should support error-triggered wiki search', () => {
    const seq = new Sequence();

    // No errors yet
    expect(seq.evaluate('seq.lastError() !== undefined && !seq.has("wiki_get")')).toBe(false);

    // An error occurs
    seq.add({
      tool: 'bash',
      args: { command: 'pnpm build' },
      result: 'Error: TypeScript compilation failed',
      timestamp: 1000,
    });

    // Should search wiki
    const shouldSearchWiki = seq.evaluate(
      'seq.lastError() !== undefined && !seq.has("wiki_get")'
    );
    expect(shouldSearchWiki).toBe(true);

    // Wiki search done
    seq.add({
      tool: 'wiki_get',
      args: { query: 'typescript error', domain: 'pitfall' },
      result: 'ok',
      timestamp: 2000,
    });

    // Should not search again
    const shouldSearchAgain = seq.evaluate(
      'seq.lastError() !== undefined && !seq.has("wiki_get")'
    );
    expect(shouldSearchAgain).toBe(false);
  });

  it('should support force push blocking', () => {
    const seq = new Sequence();

    // Regular push
    seq.add({
      tool: 'bash',
      args: { command: 'git push origin main' },
      result: 'ok',
      timestamp: 1000,
    });

    // Not force push
    expect(
      seq.evaluate('seq.last().args.command.includes("force") && seq.last().args.command.includes("main")')
    ).toBe(false);

    // Force push attempt
    seq.add({
      tool: 'bash',
      args: { command: 'git push --force origin main' },
      result: 'ok',
      timestamp: 2000,
    });

    // Should block
    expect(
      seq.evaluate('seq.last().args.command.includes("force") && seq.last().args.command.includes("main")')
    ).toBe(true);
  });

  it('should count tool occurrences correctly', () => {
    const seq = new Sequence();

    // Multiple bash calls
    for (let i = 0; i < 5; i++) {
      seq.add({ tool: 'bash', args: { command: `echo ${i}` }, result: 'ok', timestamp: i * 1000 });
    }

    // Check count
    expect(seq.evaluate('seq.count("bash") >= 3')).toBe(true);
    expect(seq.evaluate('seq.count("bash") >= 5')).toBe(true);
    expect(seq.evaluate('seq.count("bash") > 5')).toBe(false);
  });
});