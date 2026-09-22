/**
 * Tests for expression validation and testing functions
 */

import { describe, it, expect } from "vitest";
import {
  validateExpression,
  testCondition,
  createMockSequence,
} from "../hook/condition-validator.js";

describe("validateExpression()", () => {
  describe("valid expressions", () => {
    it("should accept turn.count()", () => {
      const result = validateExpression('turn.count("bash") > 0');
      expect(result.valid).toBe(true);
    });

    it("should accept session.count()", () => {
      const result = validateExpression('session.count("edit_file") > 0');
      expect(result.valid).toBe(true);
    });

    it("should accept isPlanMode()", () => {
      const result = validateExpression("isPlanMode()");
      expect(result.valid).toBe(true);
    });


    it("should accept complex boolean expressions", () => {
      const result = validateExpression('turn.count("edit_file") > 0 && turn.lastIndex("bash#lint") == -1');
      expect(result.valid).toBe(true);
    });

    it("should accept turn.hadError()", () => {
      const result = validateExpression("turn.hadError()");
      expect(result.valid).toBe(true);
    });

    it("should accept session.hadError() with tool spec", () => {
      const result = validateExpression('session.hadError("bash")');
      expect(result.valid).toBe(true);
    });



  });

  describe("legacy seq.* syntax rejection", () => {
    it("should reject seq.has()", () => {
      const result = validateExpression('seq.has("bash")');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("Legacy") || e.includes("seq"))).toBe(true);
    });

    it("should reject seq.count()", () => {
      const result = validateExpression('seq.count("bash") > 0');
      expect(result.valid).toBe(false);
    });


    it("should reject seq.lastIndexOf()", () => {
      const result = validateExpression('seq.lastIndexOf("bash#lint") == -1');
      expect(result.valid).toBe(false);
    });

  });

  describe("dangerous patterns", () => {
    it("should reject eval()", () => {
      const result = validateExpression('eval("malicious")');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("not allowed") || e.includes("Forbidden"))).toBe(true);
    });






  });

  describe("syntax errors", () => {
    it("should reject unbalanced parentheses", () => {
      const result = validateExpression('turn.count("bash"');
      expect(result.valid).toBe(false);
    });

  });

  describe("warnings", () => {
    it("should warn about === comparison", () => {
      const result = validateExpression('turn.count("bash") === true');
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("==="))).toBe(true);
    });
  });

  describe("function-only names must be called, not referenced bare", () => {
    // Regression guard for a P1 correctness bug: a bare `totalTurns` or
    // `isPlanMode` (missing parens) used to validate cleanly because the
    // names sat in ALLOWED_ROOTS, then evaluated to the function object —
    // which Boolean() coerces to `true`, producing a silently always-truthy
    // guard. They must now be rejected; only the call form is legal.
    it("should reject bare `totalTurns` (missing parens)", () => {
      const result = validateExpression("totalTurns");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("totalTurns") && e.includes("()"))).toBe(true);
    });

    it("should reject bare `isPlanMode` (missing parens)", () => {
      const result = validateExpression("isPlanMode");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("isPlanMode") && e.includes("()"))).toBe(true);
    });

    it("should reject bare `totalTurns` inside a larger expression", () => {
      // A typo like `totalTurns >= 5` (instead of `totalTurns() >= 5`) must
      // not slip through just because it's wrapped in a comparison.
      const result = validateExpression("totalTurns >= 5");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("totalTurns"))).toBe(true);
    });


  });
});

describe("testCondition()", () => {
  describe("with mock sequence", () => {
    it("should evaluate valid expression", () => {
      const mockSeq = createMockSequence([
        { tool: "bash", args: { command: "test" }, result: "ok" },
      ]);
      const result = testCondition('turn.count("bash") > 0', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });

    it("should return false for non-matching condition", () => {
      const mockSeq = createMockSequence([]);
      const result = testCondition('turn.count("bash") > 0', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(false);
    });

    it("should evaluate to false for a syntax error (no throw)", () => {
      const mockSeq = createMockSequence([]);
      const result = testCondition("turn.count(", mockSeq);
      // evaluateExpression catches jsep errors and returns false, so the
      // condition evaluates to false rather than throwing.
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(false);
    });




    it("should evaluate session.count() across turn boundary", () => {
      const mockSeq = createMockSequence([
        { tool: "edit_file", args: { path: "a" }, result: "ok" },
      ]);
      mockSeq.markPromptBoundary();
      mockSeq.addEvent("edit_file", { path: "b" }, "ok");
      const result = testCondition('session.count("edit_file") == 2', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });
  });
});


