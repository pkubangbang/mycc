/**
 * lint-after-edit-evaluate.test.ts - Unit test for evaluate() against
 * the lint-after-edit skill condition.
 *
 * The condition uses the new turn-dot/session-dot API:
 *   (turn.count('edit_file') > 0 || turn.count('write_file') > 0)
 *   && (turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')
 *       || turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint')
 *       || turn.lastIndex('bash#pnpm lint') == -1)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Sequence, type SequenceEvent } from "../../hook/sequence.js";

// ============================================================================
// Session events (extracted from a realistic transcript)
// ============================================================================

function createSessionEvents(): SequenceEvent[] {
  return [
    { tool: "recall", args: { path: "/" }, result: "ok", timestamp: 1000 },
    { tool: "recall", args: { path: "/skill" }, result: "ok", timestamp: 2000 },
    { tool: "bash", args: { command: "grep -rn skill_compile src/", intent: "find files" }, result: "ok", timestamp: 3000 },
    { tool: "bash", args: { command: "cat src/slashes/skill-compile.ts", intent: "read file" }, result: "ok", timestamp: 4000 },
    { tool: "read_file", args: { path: "src/slashes/skill-compile.ts" }, result: "ok", timestamp: 5000 },
    { tool: "brief", args: { message: "Found code", confidence: 7 }, result: "ok", timestamp: 6000 },
    { tool: "read_file", args: { path: "src/slashes/skill-compile.ts" }, result: "ok", timestamp: 7000 },
    { tool: "bash", args: { command: "grep -n action src/slashes/skill-compile.ts", intent: "find lines" }, result: "ok", timestamp: 8000 },
    { tool: "bash", args: { command: "sed -i s/.../ src/slashes/skill-compile.ts", intent: "edit" }, result: "ok", timestamp: 9000 },
    { tool: "edit_file", args: { path: "src/slashes/skill-compile.ts", old_text: "log", new_text: "log with action type" }, result: "ok", timestamp: 10000 },
    { tool: "brief", args: { message: "Added action type", confidence: 10 }, result: "ok", timestamp: 11000 },
  ];
}

// ============================================================================
// The lint-after-edit condition (new turn-dot/session-dot API)
// ============================================================================

const LINT_AFTER_EDIT_CONDITION =
  `(turn.count('edit_file') > 0 || turn.count('write_file') > 0) ` +
  `&& (turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') ` +
  `    || turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') ` +
  `    || turn.lastIndex('bash#pnpm lint') == -1)`;

// ============================================================================
// Test Cases
// ============================================================================

describe("evaluate() with lint-after-edit condition", () => {
  // ==========================================================================
  // Basic session scenario
  // ==========================================================================
  describe("without Triologue (basic scenario)", () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = new Sequence();
      for (const event of createSessionEvents()) {
        seq.add(event);
      }
    });

    it("should have all 11 events from the session", () => {
      expect(seq.getEvents()).toHaveLength(11);
    });

    it("should have edit_file event in sequence", () => {
      expect(seq.turnCount("edit_file") > 0).toBe(true);
    });

    it("should have bash events in sequence", () => {
      expect(seq.turnCount("bash") > 0).toBe(true);
    });

    it("session.count('edit_file') returns correct count", () => {
      const count = seq.sessionCount("edit_file");
      expect(count).toBe(1);
    });

    it("session.count for specific tools returns correct counts", () => {
      expect(seq.sessionCount("bash")).toBe(4);
      expect(seq.sessionCount("write_file")).toBe(0);
      expect(seq.sessionCount("recall")).toBe(2);
      expect(seq.sessionCount("read_file")).toBe(2);
      expect(seq.sessionCount("brief")).toBe(2);
    });

    it("session.count() without args returns correct session total", () => {
      expect(seq.sessionCount()).toBe(11);
    });

    it("evaluate() returns true due to edit and no lint", () => {
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it("other turn functions work correctly", () => {
      expect(seq.turnCount("edit_file") > 0).toBe(true);
      expect(seq.turnCount("write_file") > 0).toBe(false);

      // lastIndex for edit_file should be the index of the edit_file event
      const editIdx = seq.turnLastIndex("edit_file");
      expect(editIdx).not.toBe(-1);
      expect(editIdx).toBeGreaterThanOrEqual(0);

      // lastIndex for bash#pnpm lint should be -1 (no lint was run)
      const lintIdx = seq.turnLastIndex("bash#pnpm lint");
      expect(lintIdx).toBe(-1);
    });

    it("count() (turn-scoped) correctly counts edit_file in current turn", () => {
      expect(seq.turnCount("edit_file")).toBe(1);
    });

    it("the condition works with session.count() as well", () => {
      const sessionBasedCondition =
        `(session.count('edit_file') > 0 || session.count('write_file') > 0) ` +
        `&& (turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') ` +
        `    || turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') ` +
        `    || turn.lastIndex('bash#pnpm lint') == -1)`;

      expect(seq.evaluate(sessionBasedCondition)).toBe(true);
    });
  });

  // ==========================================================================
  // Empty sequence edge cases
  // ==========================================================================
  describe("empty sequence", () => {
    it("evaluate() returns false for empty sequence", () => {
      const seq = new Sequence();
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });

  // ==========================================================================
  // Only write_file (no edit_file) scenario
  // ==========================================================================
  describe("write_file scenario", () => {
    it("session.count('write_file') returns correct count", () => {
      const seq = new Sequence();
      seq.add({
        tool: "write_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: Date.now(),
      });

      expect(seq.sessionCount("write_file")).toBe(1);
    });

    it("evaluate() returns true for write_file-only scenario", () => {
      const seq = new Sequence();
      seq.add({
        tool: "write_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: Date.now(),
      });

      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(true);
    });
  });

  // ==========================================================================
  // lastIndex comparisons verified independently
  // ==========================================================================
  describe("lastIndex comparison logic", () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = new Sequence();
    });

    it("edit >= lint returns true when lint was never run (-1)", () => {
      seq.add({
        tool: "edit_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: 1000,
      });

      const editIdx = seq.turnLastIndex("edit_file");
      const lintIdx = seq.turnLastIndex("bash#pnpm lint");
      expect(editIdx).toBeGreaterThanOrEqual(0);
      expect(lintIdx).toBe(-1);
      expect(editIdx >= lintIdx).toBe(true);

      const onlyLastPart = `(turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') || turn.lastIndex('bash#pnpm lint') == -1)`;
      expect(seq.evaluate(onlyLastPart)).toBe(true);
    });

    it("edit >= lint returns false when lint was run after edit", () => {
      seq.add({
        tool: "edit_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: 1000,
      });
      seq.add({
        tool: "bash",
        args: { command: "pnpm lint", intent: "lint" },
        result: "0 errors",
        timestamp: 2000,
      });

      const editIdx = seq.turnLastIndex("edit_file");
      const lintIdx = seq.turnLastIndex("bash#pnpm lint");
      expect(editIdx).toBe(0);
      expect(lintIdx).toBe(1);
      expect(editIdx >= lintIdx).toBe(false);

      const onlyLastPart = `(turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') || turn.lastIndex('bash#pnpm lint') == -1)`;
      expect(seq.evaluate(onlyLastPart)).toBe(false);
    });

    it("edit >= lint returns true when edit was run after lint", () => {
      seq.add({
        tool: "bash",
        args: { command: "pnpm lint", intent: "lint" },
        result: "0 errors",
        timestamp: 1000,
      });
      seq.add({
        tool: "edit_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: 2000,
      });

      const editIdx = seq.turnLastIndex("edit_file");
      const lintIdx = seq.turnLastIndex("bash#pnpm lint");
      expect(editIdx).toBe(1);
      expect(lintIdx).toBe(0);
      expect(editIdx >= lintIdx).toBe(true);
    });
  });

  // ==========================================================================
  // Evaluator robustness
  // ==========================================================================
  describe("evaluator robustness", () => {
    it("should handle complex boolean expression with many conditions", () => {
      const seq = new Sequence();
      seq.add({
        tool: "edit_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: 1000,
      });

      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it("should not crash on deeply nested condition", () => {
      const seq = new Sequence();
      const expr = LINT_AFTER_EDIT_CONDITION;
      // Should at minimum not throw
      expect(() => seq.evaluate(expr)).not.toThrow();
    });

    it("should handle condition with only the lastIndex part", () => {
      const seq = new Sequence();
      seq.add({
        tool: "edit_file",
        args: { path: "test.ts" },
        result: "ok",
        timestamp: 1000,
      });

      const lastPartOnly =
        `turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') ` +
        `|| turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') ` +
        `|| turn.lastIndex('bash#pnpm lint') == -1`;

      expect(seq.evaluate(lastPartOnly)).toBe(true);
    });
  });

  // ==========================================================================
  // Session transcript data fidelity
  // ==========================================================================
  describe("session transcript data fidelity", () => {
    it("session transcript should contain 11 tool events", () => {
      expect(createSessionEvents()).toHaveLength(11);
    });

    it("tool event sequence should match expected pattern", () => {
      const toolNames = createSessionEvents().map(e => e.tool);

      expect(toolNames).toContain("edit_file");
      expect(toolNames).toContain("bash");
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("recall");
      expect(toolNames).toContain("brief");
    });
  });
});
