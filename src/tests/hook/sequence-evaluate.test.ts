/**
 * Tests for Sequence.evaluate() - specifically targeting the lint-after-edit condition.
 *
 * The condition uses the new turn-dot/session-dot API:
 *   (turn.count('edit_file') > 0 || turn.count('write_file') > 0)
 *   && (turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')
 *       || turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint')
 *       || turn.lastIndex('bash#pnpm lint') == -1)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Sequence, type SequenceEvent } from "../../hook/sequence.js";
import { evaluateExpression, type EvalContext } from "../../hook/evaluator.js";

// ============================================================================
// Realistic session events
// ============================================================================

function createSessionEvents(): SequenceEvent[] {
  return [
    { tool: "recall", args: { path: "/" }, result: "ok", timestamp: 1000 },
    { tool: "recall", args: { path: "/skill" }, result: "ok", timestamp: 2000 },
    { tool: "bash", args: { command: "find src -name *.ts", intent: "find files" }, result: "ok", timestamp: 3000 },
    { tool: "bash", args: { command: "find src -name *.ts", intent: "READ SOURCE TO find skill_compile" }, result: "ok", timestamp: 4000 },
    { tool: "read_file", args: { path: "src/tools/skill_compile.ts" }, result: "ok", timestamp: 5000 },
    { tool: "brief", args: { message: "Found skill_compile.ts...", confidence: 7 }, result: "ok", timestamp: 6000 },
    { tool: "read_file", args: { path: "src/hook/conditions.ts" }, result: "ok", timestamp: 7000 },
    { tool: "bash", args: { command: "grep -n brief src/tools/skill_compile.ts", intent: "READ SOURCE TO find brief log output lines" }, result: "ok", timestamp: 8000 },
    { tool: "bash", args: { command: "sed -n 125,135p src/tools/skill_compile.ts", intent: "READ SOURCE TO see brief output context" }, result: "ok", timestamp: 9000 },
    { tool: "edit_file", args: { path: "src/tools/skill_compile.ts", old_text: "original", new_text: "modified" }, result: "ok", timestamp: 10000 },
    { tool: "brief", args: { message: "Added action type to skill_compile...", confidence: 9 }, result: "ok", timestamp: 11000 },
  ];
}

/**
 * The exact compiled condition for lint-after-edit (v8, new API)
 */
const LINT_AFTER_EDIT_CONDITION =
  "(turn.count('edit_file') > 0 || turn.count('write_file') > 0) && " +
  "(turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') || " +
  "turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') || " +
  "turn.lastIndex('bash#pnpm lint') == -1)";

/**
 * Simplified version using session.count instead of turn.count
 */
const LINT_AFTER_EDIT_SESSION =
  "(session.count('edit_file') > 0 || session.count('write_file') > 0) && " +
  "(turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') || " +
  "turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') || " +
  "turn.lastIndex('bash#pnpm lint') == -1)";

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

describe("Sequence.evaluate() - lint-after-edit condition", () => {
  // ------------------------------------------------------
  // Scenario 1: From session transcript (edit_file used, no lint run)
  // ------------------------------------------------------
  describe("Scenario 1: edit_file used, no lint run (from session transcript)", () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = createSequence(createSessionEvents());
    });

    it("should detect edit_file is present", () => {
      expect(seq.turnCount("edit_file") > 0).toBe(true);
    });

    it("should detect no lint was run", () => {
      expect(seq.turnLastIndex("bash#pnpm lint")).toBe(-1);
    });

    it("should evaluate lastIndex comparison: edit >= lint", () => {
      // edit_file at index 9, bash#pnpm lint at -1 (not found)
      // 9 >= -1 -> true
      expect(seq.turnLastIndex("edit_file")).toBe(9);
      expect(seq.turnLastIndex("bash#pnpm lint")).toBe(-1);
      expect(seq.evaluate("turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')")).toBe(true);
    });

    it("should evaluate the bash#pnpm lint == -1 sub-condition", () => {
      expect(seq.evaluate("turn.lastIndex('bash#pnpm lint') == -1")).toBe(true);
    });

    it("should evaluate the full lint-after-edit condition as TRUE", () => {
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it("should evaluate the session-based condition correctly", () => {
      expect(seq.evaluate(LINT_AFTER_EDIT_SESSION)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 2: edit_file then lint run (lint AFTER edit)
  // ------------------------------------------------------
  describe("Scenario 2: edit_file then lint run (clean state)", () => {
    it("should return FALSE - lint was run after edit, no need to block", () => {
      const seq = new Sequence();
      seq.add({ tool: "edit_file", args: { path: "test.ts" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "bash", args: { command: "pnpm lint", intent: "lint" }, result: "ok", timestamp: 2000 });

      // lint at index 1, edit at index 0
      // 0 >= 1 -> false, and bash#pnpm lint != -1
      expect(seq.turnLastIndex("edit_file")).toBe(0);
      expect(seq.turnLastIndex("bash#pnpm lint")).toBe(1);

      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });

  // ------------------------------------------------------
  // Scenario 3: lint then edit (edit AFTER lint - dirty)
  // ------------------------------------------------------
  describe("Scenario 3: lint then edit (edit AFTER lint - dirty state)", () => {
    it("should return TRUE - edit was made after lint, need to re-lint", () => {
      const seq = new Sequence();
      seq.add({ tool: "bash", args: { command: "pnpm lint", intent: "lint" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "edit_file", args: { path: "test.ts" }, result: "ok", timestamp: 2000 });

      // edit at index 1, lint at index 0
      // 1 >= 0 -> true
      expect(seq.turnLastIndex("edit_file")).toBe(1);
      expect(seq.turnLastIndex("bash#pnpm lint")).toBe(0);

      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 4: No edits at all (no files changed)
  // ------------------------------------------------------
  describe("Scenario 4: No file edits at all", () => {
    it("should return FALSE - no edits to lint", () => {
      const seq = new Sequence();
      seq.add({ tool: "bash", args: { command: "echo hello" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "read_file", args: { path: "test.ts" }, result: "ok", timestamp: 2000 });

      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });

  // ------------------------------------------------------
  // Scenario 5: Multiple edits, no lint
  // ------------------------------------------------------
  describe("Scenario 5: Multiple edits, no lint run", () => {
    it("should return TRUE - edits made without lint", () => {
      const seq = new Sequence();
      seq.add({ tool: "edit_file", args: { path: "a.ts" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "read_file", args: { path: "b.ts" }, result: "ok", timestamp: 2000 });
      seq.add({ tool: "edit_file", args: { path: "c.ts" }, result: "ok", timestamp: 3000 });

      expect(seq.turnLastIndex("edit_file")).toBe(2);
      expect(seq.turnLastIndex("bash#pnpm lint")).toBe(-1);
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 6: write_file used (not edit_file)
  // ------------------------------------------------------
  describe("Scenario 6: write_file used, no lint", () => {
    it("should return TRUE - write_file is also a file change", () => {
      const seq = new Sequence();
      seq.add({ tool: "write_file", args: { path: "new.ts" }, result: "ok", timestamp: 1000 });

      expect(seq.turnCount("write_file") > 0).toBe(true);
      expect(seq.turnLastIndex("write_file")).toBe(0);
      expect(seq.turnLastIndex("bash#pnpm lint")).toBe(-1);
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(true);
    });
  });

  // ------------------------------------------------------
  // Scenario 7: write_file then lint (clean)
  // ------------------------------------------------------
  describe("Scenario 7: write_file then lint (clean)", () => {
    it("should return FALSE - lint was run after write", () => {
      const seq = new Sequence();
      seq.add({ tool: "write_file", args: { path: "new.ts" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "bash", args: { command: "pnpm lint", intent: "lint" }, result: "ok", timestamp: 2000 });

      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });

  // ------------------------------------------------------
  // Scenario 8: Empty sequence (no events at all)
  // ------------------------------------------------------
  describe("Scenario 8: Empty sequence", () => {
    it("should return FALSE - no edits and no lint", () => {
      const seq = new Sequence();
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });
});

// ============================================================================
// Tests: session.count() with #pattern
// ============================================================================

describe("session.count() with #pattern", () => {
  it("session.count('skill_load#plan-quality') counts session-wide skill_load calls matching the name pattern", () => {
    const seq = new Sequence();
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: 1000 });
    seq.add({ tool: "skill_load", args: { name: "create-skill" }, result: "ok", timestamp: 2000 });
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: 3000 });

    expect(seq.sessionCount("skill_load#plan-quality")).toBe(2);
  });

  it("session.count('skill_load#plan-quality') returns 0 when the skill was never loaded", () => {
    const seq = new Sequence();
    seq.add({ tool: "skill_load", args: { name: "create-skill" }, result: "ok", timestamp: 1000 });

    expect(seq.sessionCount("skill_load#plan-quality")).toBe(0);
  });

  it("session.count('skill_load#plan-quality') survives turn boundaries (session-level)", () => {
    const seq = new Sequence();
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: 1000 });

    // Simulate a turn boundary - events array is cleared, but session-level
    // pattern log must persist so the dedup guard still sees the prior load.
    seq.markPromptBoundary();

    seq.add({ tool: "edit_file", args: { path: "x.ts" }, result: "ok", timestamp: 2000 });

    expect(seq.sessionCount("skill_load#plan-quality")).toBe(1);
  });

  it("session.count('bash#pnpm lint') counts session-wide bash calls matching prefix", () => {
    const seq = new Sequence();
    seq.add({ tool: "bash", args: { command: "pnpm lint", intent: "lint" }, result: "ok", timestamp: 1000 });
    seq.add({ tool: "bash", args: { command: "pnpm test", intent: "test" }, result: "ok", timestamp: 2000 });
    seq.add({ tool: "bash", args: { command: "pnpm lint", intent: "lint" }, result: "ok", timestamp: 3000 });

    expect(seq.sessionCount("bash#pnpm lint")).toBe(2);
  });

  it("the dedup condition isPlanMode() && session.count('skill_load#plan-quality') == 0 evaluates correctly", () => {
    const seq = new Sequence(undefined, () => "plan");
    // No skill_load yet -> condition true (hook should fire)
    expect(seq.evaluate("isPlanMode() && session.count('skill_load#plan-quality') == 0")).toBe(true);

    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: 1000 });
    // Skill loaded this session -> condition false (hook should not fire again)
    expect(seq.evaluate("isPlanMode() && session.count('skill_load#plan-quality') == 0")).toBe(false);
  });
});

// ============================================================================
// Tests: Evaluator edge cases
// ============================================================================

describe("evaluateExpression() edge cases", () => {
  it("should handle lastIndex returning -1 for both sides", () => {
    const ctx: EvalContext = {
      turnCount: () => 0,
      turnLastIndex: () => -1,
      turnCountResult: () => 0,
      turnHadError: () => false,
      sessionCount: () => 0,
      sessionLastIndex: () => -1,
      sessionCountResult: () => 0,
      sessionHadError: () => false,
      isPlanMode: () => false,
    };

    // -1 >= -1 should be true (both not found = equal)
    expect(evaluateExpression("turn.lastIndex('a') >= turn.lastIndex('b')", ctx)).toBe(true);

    // -1 == -1 should be true
    expect(evaluateExpression("turn.lastIndex('x') == -1", ctx)).toBe(true);

    // -1 != -1 should be false
    expect(evaluateExpression("turn.lastIndex('x') != -1", ctx)).toBe(false);
  });

  it("should handle -1 compared to a real index", () => {
    let callCount = 0;
    const ctx: EvalContext = {
      turnCount: () => 0,
      turnLastIndex: () => {
        callCount++;
        return callCount === 1 ? 5 : -1;
      },
      turnCountResult: () => 0,
      turnHadError: () => false,
      sessionCount: () => 0,
      sessionLastIndex: () => -1,
      sessionCountResult: () => 0,
      sessionHadError: () => false,
      isPlanMode: () => false,
    };

    // 5 >= -1 -> true
    expect(evaluateExpression("turn.lastIndex('edit_file') >= turn.lastIndex('bash#lint')", ctx)).toBe(true);
  });

  it("should handle compound OR with three conditions", () => {
    const ctx: EvalContext = {
      turnCount: () => 0,
      turnLastIndex: (pattern: string) => {
        if (pattern === "edit_file") return 0;
        if (pattern === "write_file") return -1;
        if (pattern.includes("bash#pnpm lint")) return -1;
        return -1;
      },
      turnCountResult: () => 0,
      turnHadError: () => false,
      sessionCount: () => 0,
      sessionLastIndex: () => -1,
      sessionCountResult: () => 0,
      sessionHadError: () => false,
      isPlanMode: () => false,
    };

    const expr = "turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') || turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') || turn.lastIndex('bash#pnpm lint') == -1";
    // edit_file (0) >= lint (-1) -> true -> short-circuit, whole expression true
    expect(evaluateExpression(expr, ctx)).toBe(true);
  });

  it("should handle turn.count() > 0 as boolean", () => {
    const ctx: EvalContext = {
      turnCount: (t?: string) => t === "edit_file" ? 1 : 0,
      turnLastIndex: () => -1,
      turnCountResult: () => 0,
      turnHadError: () => false,
      sessionCount: () => 0,
      sessionLastIndex: () => -1,
      sessionCountResult: () => 0,
      sessionHadError: () => false,
      isPlanMode: () => false,
    };

    expect(evaluateExpression("turn.count('edit_file') > 0", ctx)).toBe(true);
    expect(evaluateExpression("turn.count('write_file') > 0", ctx)).toBe(false);
  });
});

// ============================================================================
// Tests: turn.count vs session.count scope
// ============================================================================

describe("turn.count vs session.count scope", () => {
  it("turn.count() without args should work correctly", () => {
    const seq = new Sequence();
    seq.add({ tool: "edit_file", args: { path: "test.ts" }, result: "ok", timestamp: 1000 });
    seq.add({ tool: "bash", args: { command: "echo hello" }, result: "ok", timestamp: 2000 });
    // Clear turn (simulate turn boundary)
    seq.markPromptBoundary();
    seq.add({ tool: "write_file", args: { path: "new.ts" }, result: "ok", timestamp: 3000 });

    // Current turn has 1 event, but session total has 3
    expect(seq.turnCount()).toBe(1);
    // session.count without args uses totalEventsCount (session-level, 3)
    expect(seq.sessionCount()).toBe(3);
  });

  it("the condition relying on session.count('edit_file') > 0 succeeds", () => {
    const seq = new Sequence();
    seq.add({ tool: "edit_file", args: { path: "test.ts" }, result: "ok", timestamp: 1000 });

    const result = seq.evaluate("session.count('edit_file') > 0");
    expect(result).toBe(true);
  });
});
