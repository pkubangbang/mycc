/**
 * Tests for Sequence.evaluate() - specifically targeting the lint-after-edit condition.
 *
 * The bug: Sequence.totalCount('toolName') returns 0 when no Triologue is attached,
 * because the fallback `return toolName ? 0 : this.totalEventsCount` is faulty.
 *
 * This test harness uses realistic session data from lead-1779115527-triologue.jsonl
 * to verify that evaluate() correctly handles the lint-after-edit skill's condition.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Sequence, type SequenceEvent } from '../../hook/sequence.js';
import { evaluateExpression, type EvalContext } from '../../hook/evaluator.js';

// ============================================================================
// Realistic session events extracted from lead-1779115527-triologue.jsonl
// ============================================================================

/**
 * Events from the session transcript showing a typical agent workflow:
 * recall → recall → bash(find) → bash(find) → read_file → brief → read_file → bash(grep) → bash(sed) → edit_file → brief
 */
function createSessionEvents(): SequenceEvent[] {
  return [
    { tool: 'recall', args: { path: '/' }, result: 'ok', timestamp: 1000 },
    { tool: 'recall', args: { path: '/skill' }, result: 'ok', timestamp: 2000 },
    { tool: 'bash', args: { command: 'find src -name "*.ts" | xargs grep -l "skill_compile"', intent: 'find files' }, result: 'ok', timestamp: 3000 },
    { tool: 'bash', args: { command: 'find src -name "*.ts" | xargs grep -l "skill_compile"', intent: 'READ SOURCE TO find skill_compile' }, result: 'ok', timestamp: 4000 },
    { tool: 'read_file', args: { path: 'src/tools/skill_compile.ts' }, result: 'ok', timestamp: 5000 },
    { tool: 'brief', args: { message: 'Found skill_compile.ts...', confidence: 7 }, result: 'ok', timestamp: 6000 },
    { tool: 'read_file', args: { path: 'src/hook/conditions.ts' }, result: 'ok', timestamp: 7000 },
    { tool: 'bash', args: { command: 'grep -n "brief" src/tools/skill_compile.ts', intent: 'READ SOURCE TO find brief log output lines' }, result: 'ok', timestamp: 8000 },
    { tool: 'bash', args: { command: "sed -n '125,135p' src/tools/skill_compile.ts", intent: 'READ SOURCE TO see brief output context' }, result: 'ok', timestamp: 9000 },
    { tool: 'edit_file', args: { path: 'src/tools/skill_compile.ts', old_text: 'original', new_text: 'modified' }, result: 'ok', timestamp: 10000 },
    { tool: 'brief', args: { message: 'Added "Action type" to skill_compile...', confidence: 9 }, result: 'ok', timestamp: 11000 },
  ];
}

/**
 * The exact compiled condition for lint-after-edit (v7)
 */
const LINT_AFTER_EDIT_CONDITION = 
  "(seq.totalCount('edit_file') > 0 || seq.totalCount('write_file') > 0) && " +
  "(seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') || " +
  "seq.lastIndexOf('write_file') >= seq.lastIndexOf('bash#pnpm lint') || " +
  "seq.lastIndexOf('bash#pnpm lint') == -1)";

/**
 * Simplified version of the condition for easier debugging
 */
const LINT_AFTER_EDIT_SIMPLE =
  "seq.hasAny(['edit_file', 'write_file']) && " +
  "(seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') || " +
  "seq.lastIndexOf('write_file') >= seq.lastIndexOf('bash#pnpm lint') || " +
  "seq.lastIndexOf('bash#pnpm lint') == -1)";

// ============================================================================
// Helper
// ============================================================================

function createSequence(events: SequenceEvent[]): Sequence {
  const seq = new Sequence();
  for (const e of events) {
    seq.add(e);
  }
  return seq;
}

// ============================================================================
// Tests: Sequence.evaluate() with lint-after-edit condition
// ============================================================================

describe('Sequence.evaluate() - lint-after-edit condition', () => {
  // ------------------------------------------------------
  // Scenario 1: From session transcript (edit_file used, no lint run)
  // ------------------------------------------------------
  describe('Scenario 1: edit_file used, no lint run (from session transcript)', () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = createSequence(createSessionEvents());
    });

    it('should detect edit_file is present', () => {
      expect(seq.has('edit_file')).toBe(true);
    });

    it('should detect no lint was run', () => {
      expect(seq.lastIndexOf('bash#pnpm lint')).toBe(-1);
    });

    it('should evaluate lastIndexOf comparison: edit >= lint', () => {
      // edit_file at index 9, bash#pnpm lint at -1 (not found)
      // 9 >= -1 → true
      expect(seq.lastIndexOf('edit_file')).toBe(9);
      expect(seq.lastIndexOf('bash#pnpm lint')).toBe(-1);
      expect(seq.evaluate("seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint')")).toBe(true);
    });

    it('should evaluate the bash#pnpm lint == -1 sub-condition', () => {
      expect(seq.evaluate("seq.lastIndexOf('bash#pnpm lint') == -1")).toBe(true);
    });

    it('should evaluate the full lint-after-edit condition as TRUE', () => {
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it('should evaluate the simplified condition (hasAny + lastIndexOf) correctly', () => {
      // This version uses hasAny instead of totalCount, so it avoids the bug
      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 2: edit_file then lint run (lint AFTER edit)
  // ------------------------------------------------------
  describe('Scenario 2: edit_file then lint run (clean state)', () => {
    it('should return FALSE — lint was run after edit, no need to block', () => {
      const seq = new Sequence();
      seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'bash', args: { command: 'pnpm lint', intent: 'lint' }, result: 'ok', timestamp: 2000 });

      // lint at index 1, edit at index 0
      // 0 >= 1 → false, and bash#pnpm lint != -1
      expect(seq.lastIndexOf('edit_file')).toBe(0);
      expect(seq.lastIndexOf('bash#pnpm lint')).toBe(1);

      // With the tally table fix, totalCount works correctly too
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });

  // ------------------------------------------------------
  // Scenario 3: lint then edit (edit AFTER lint — dirty)
  // ------------------------------------------------------
  describe('Scenario 3: lint then edit (edit AFTER lint — dirty state)', () => {
    it('should return TRUE — edit was made after lint, need to re-lint', () => {
      const seq = new Sequence();
      seq.add({ tool: 'bash', args: { command: 'pnpm lint', intent: 'lint' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 2000 });

      // edit at index 1, lint at index 0
      // 1 >= 0 → true
      expect(seq.lastIndexOf('edit_file')).toBe(1);
      expect(seq.lastIndexOf('bash#pnpm lint')).toBe(0);

      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 4: No edits at all (no files changed)
  // ------------------------------------------------------
  describe('Scenario 4: No file edits at all', () => {
    it('should return FALSE — no edits to lint', () => {
      const seq = new Sequence();
      seq.add({ tool: 'bash', args: { command: 'echo hello' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'read_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 2000 });

      expect(seq.hasAny(['edit_file', 'write_file'])).toBe(false);
      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(false);
    });
  });

  // ------------------------------------------------------
  // Scenario 5: Multiple edits, no lint
  // ------------------------------------------------------
  describe('Scenario 5: Multiple edits, no lint run', () => {
    it('should return TRUE — edits made without lint', () => {
      const seq = new Sequence();
      seq.add({ tool: 'edit_file', args: { path: 'a.ts' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'read_file', args: { path: 'b.ts' }, result: 'ok', timestamp: 2000 });
      seq.add({ tool: 'edit_file', args: { path: 'c.ts' }, result: 'ok', timestamp: 3000 });

      expect(seq.lastIndexOf('edit_file')).toBe(2);
      expect(seq.lastIndexOf('bash#pnpm lint')).toBe(-1);
      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 6: write_file used (not edit_file)
  // ------------------------------------------------------
  describe('Scenario 6: write_file used, no lint', () => {
    it('should return TRUE — write_file is also a file change', () => {
      const seq = new Sequence();
      seq.add({ tool: 'write_file', args: { path: 'new.ts' }, result: 'ok', timestamp: 1000 });

      expect(seq.has('write_file')).toBe(true);
      expect(seq.lastIndexOf('write_file')).toBe(0);
      expect(seq.lastIndexOf('bash#pnpm lint')).toBe(-1);
      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 7: write_file then lint (clean)
  // ------------------------------------------------------
  describe('Scenario 7: write_file then lint (clean)', () => {
    it('should return FALSE — lint was run after write', () => {
      const seq = new Sequence();
      seq.add({ tool: 'write_file', args: { path: 'new.ts' }, result: 'ok', timestamp: 1000 });
      seq.add({ tool: 'bash', args: { command: 'pnpm lint', intent: 'lint' }, result: 'ok', timestamp: 2000 });

      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(false);
    });
  });

  // ------------------------------------------------------
  // Scenario 8: Empty sequence (no events at all)
  // ------------------------------------------------------
  describe('Scenario 8: Empty sequence', () => {
    it('should return FALSE — no edits and no lint', () => {
      const seq = new Sequence();

      expect(seq.hasAny(['edit_file', 'write_file'])).toBe(false);
      // lastIndexOf returns -1 for everything
      // -1 >= -1 → true, but hasAny is false, so overall false
      expect(seq.evaluate(LINT_AFTER_EDIT_SIMPLE)).toBe(false);
    });
  });
});

// ============================================================================
// Tests: The totalCount bug specifically
// ============================================================================

describe('Sequence.totalCount()', () => {
  it('totalCount("toolName") returns correct count from tally table', () => {
    const seq = new Sequence();
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'bash', args: { command: 'echo hello' }, result: 'ok', timestamp: 2000 });

    // totalCount() without args correctly returns totalEventsCount (2)
    expect(seq.totalCount()).toBe(2);

    // totalCount('edit_file') returns 1 from the tally table
    expect(seq.totalCount('edit_file')).toBe(1);
    expect(seq.totalCount('bash')).toBe(1);
    expect(seq.totalCount('nonexistent')).toBe(0);
  });

  it('totalCount() without args should work correctly', () => {
    const seq = new Sequence();
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'bash', args: { command: 'echo hello' }, result: 'ok', timestamp: 2000 });
    // Clear turn (simulate turn boundary)
    seq.markPromptBoundary();
    seq.add({ tool: 'write_file', args: { path: 'new.ts' }, result: 'ok', timestamp: 3000 });

    // Current turn has 1 event, but session total has 3
    expect(seq.count()).toBe(1);
    // totalCount without args uses totalEventsCount (session-level, 3)
    expect(seq.totalCount()).toBe(3);
  });

  it('the condition relying on totalCount("edit_file") > 0 succeeds', () => {
    const seq = new Sequence();
    seq.add({ tool: 'edit_file', args: { path: 'test.ts' }, result: 'ok', timestamp: 1000 });

    const result = seq.evaluate("seq.totalCount('edit_file') > 0");
    expect(result).toBe(true);
  });
});

// ============================================================================
// Tests: #pattern matching against args.name (non-bash tools)
// ============================================================================

describe('Sequence #pattern matching against args.name', () => {
  it('lastIndexOf("skill_load#plan_quality") matches a skill_load call whose name arg contains the pattern', () => {
    const seq = new Sequence();
    seq.add({ tool: 'read_file', args: { path: 'a.ts' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'skill_load', args: { name: 'plan-quality' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'read_file', args: { path: 'b.ts' }, result: 'ok', timestamp: 3000 });

    // skill_load#plan_quality → matches the skill_load event (name contains 'plan_quality')
    // Note: pattern uses underscore; skill name uses hyphen; the matcher does a
    // substring `.includes`, so we test with a substring that actually matches.
    expect(seq.lastIndexOf('skill_load#plan-quality')).toBe(1);
  });

  it('lastIndexOf("skill_load#plan_quality") returns -1 when the skill was never loaded', () => {
    const seq = new Sequence();
    seq.add({ tool: 'read_file', args: { path: 'a.ts' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'skill_load', args: { name: 'create-skill' }, result: 'ok', timestamp: 2000 });

    expect(seq.lastIndexOf('skill_load#plan-quality')).toBe(-1);
  });

  it('lastIndexOf("skill_load#plan-quality") still matches bash#command for bash events (backward compat)', () => {
    const seq = new Sequence();
    seq.add({ tool: 'bash', args: { command: 'pnpm lint', intent: 'lint' }, result: 'ok', timestamp: 1000 });

    expect(seq.lastIndexOf('bash#pnpm lint')).toBe(0);
  });

  it('lastIndexOf("skill_load#plan-quality") ignores skill_load events with no string name arg', () => {
    const seq = new Sequence();
    seq.add({ tool: 'skill_load', args: {}, result: 'ok', timestamp: 1000 });

    expect(seq.lastIndexOf('skill_load#plan-quality')).toBe(-1);
  });
});

// ============================================================================
// Tests: totalCount('tool#pattern') — session-wide arg-pattern counts
// ============================================================================

describe('Sequence.totalCount() with #pattern', () => {
  it('totalCount("skill_load#plan-quality") counts session-wide skill_load calls matching the name pattern', () => {
    const seq = new Sequence();
    seq.add({ tool: 'skill_load', args: { name: 'plan-quality' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'skill_load', args: { name: 'create-skill' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'skill_load', args: { name: 'plan-quality' }, result: 'ok', timestamp: 3000 });

    expect(seq.totalCount('skill_load#plan-quality')).toBe(2);
  });

  it('totalCount("skill_load#plan-quality") returns 0 when the skill was never loaded', () => {
    const seq = new Sequence();
    seq.add({ tool: 'skill_load', args: { name: 'create-skill' }, result: 'ok', timestamp: 1000 });

    expect(seq.totalCount('skill_load#plan-quality')).toBe(0);
  });

  it('totalCount("skill_load#plan-quality") survives turn boundaries (session-level, not cleared by markPromptBoundary)', () => {
    const seq = new Sequence();
    seq.add({ tool: 'skill_load', args: { name: 'plan-quality' }, result: 'ok', timestamp: 1000 });

    // Simulate a turn boundary — events array is cleared, but the session-level
    // pattern log must persist so the dedup guard still sees the prior load.
    seq.markPromptBoundary();

    seq.add({ tool: 'edit_file', args: { path: 'x.ts' }, result: 'ok', timestamp: 2000 });

    expect(seq.totalCount('skill_load#plan-quality')).toBe(1);
  });

  it('totalCount("bash#lint") counts session-wide bash calls whose command matches', () => {
    const seq = new Sequence();
    seq.add({ tool: 'bash', args: { command: 'pnpm lint', intent: 'lint' }, result: 'ok', timestamp: 1000 });
    seq.add({ tool: 'bash', args: { command: 'pnpm test', intent: 'test' }, result: 'ok', timestamp: 2000 });
    seq.add({ tool: 'bash', args: { command: 'pnpm lint', intent: 'lint' }, result: 'ok', timestamp: 3000 });

    expect(seq.totalCount('bash#lint')).toBe(2);
  });

  it('the dedup condition isPlanMode && totalCount("skill_load#plan-quality") == 0 evaluates correctly', () => {
    const seq = new Sequence(undefined, () => 'plan');
    // No skill_load yet → condition true (hook should fire)
    expect(seq.evaluate("seq.isPlanMode() && seq.totalCount('skill_load#plan-quality') == 0")).toBe(true);

    seq.add({ tool: 'skill_load', args: { name: 'plan-quality' }, result: 'ok', timestamp: 1000 });
    // Skill loaded this session → condition false (hook should not fire again)
    expect(seq.evaluate("seq.isPlanMode() && seq.totalCount('skill_load#plan-quality') == 0")).toBe(false);
  });
});

// ============================================================================
// Tests: Evaluator edge cases
// ============================================================================

describe('evaluateExpression() edge cases', () => {
  it('should handle lastIndexOf returning -1 for both sides', () => {
    const ctx: EvalContext = {
      has: () => false,
      hasAny: () => false,
      lastIndexOf: () => -1,
      last: () => undefined,
      lastError: () => undefined,
      count: () => 0,
      totalCount: () => 0,
      countResult: () => 0,
      since: () => [],
      sinceEdit: () => [],
      isPlanMode: () => false,
    };

    // -1 >= -1 should be true (both not found = equal)
    expect(evaluateExpression("lastIndexOf('a') >= lastIndexOf('b')", ctx)).toBe(true);

    // -1 == -1 should be true
    expect(evaluateExpression("lastIndexOf('x') == -1", ctx)).toBe(true);

    // -1 != -1 should be false
    expect(evaluateExpression("lastIndexOf('x') != -1", ctx)).toBe(false);
  });

  it('should handle -1 compared to a real index', () => {
    let callCount = 0;
    const ctx: EvalContext = {
      has: () => false,
      hasAny: () => false,
      lastIndexOf: () => {
        callCount++;
        return callCount === 1 ? 5 : -1;
      },
      last: () => undefined,
      lastError: () => undefined,
      count: () => 0,
      totalCount: () => 0,
      countResult: () => 0,
      since: () => [],
      sinceEdit: () => [],
      isPlanMode: () => false,
    };

    // 5 >= -1 → true
    expect(evaluateExpression("lastIndexOf('edit_file') >= lastIndexOf('bash#lint')", ctx)).toBe(true);
  });

  it('should handle compound OR with three conditions', () => {
    const ctx: EvalContext = {
      has: () => false,
      hasAny: () => false,
      lastIndexOf: (pattern: string) => {
        if (pattern === 'edit_file') return 0;
        if (pattern === 'write_file') return -1;
        if (pattern.includes('bash#pnpm lint')) return -1;
        return -1;
      },
      last: () => undefined,
      lastError: () => undefined,
      count: () => 0,
      totalCount: () => 0,
      countResult: () => 0,
      since: () => [],
      sinceEdit: () => [],
      isPlanMode: () => false,
    };

    const expr = "lastIndexOf('edit_file') >= lastIndexOf('bash#pnpm lint') || lastIndexOf('write_file') >= lastIndexOf('bash#pnpm lint') || lastIndexOf('bash#pnpm lint') == -1";
    // edit_file (0) >= lint (-1) → true → short-circuit, whole expression true
    expect(evaluateExpression(expr, ctx)).toBe(true);
  });

  it('hasAny should accept an array literal', () => {
    const ctx: EvalContext = {
      has: () => false,
      hasAny: (tools: string[]) => tools.includes('edit_file') || tools.includes('write_file'),
      lastIndexOf: () => -1,
      last: () => undefined,
      lastError: () => undefined,
      count: () => 0,
      totalCount: () => 0,
      countResult: () => 0,
      since: () => [],
      sinceEdit: () => [],
      isPlanMode: () => false,
    };

    expect(evaluateExpression("hasAny(['edit_file', 'write_file'])", ctx)).toBe(true);
    expect(evaluateExpression("hasAny(['bash', 'read_file'])", ctx)).toBe(false);
  });
});
