/**
 * Tests for expression validation and testing functions
 */

import { describe, it, expect } from "vitest";
import {
  validateExpression,
  testCondition,
  smokeTestExpression,
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

    it("should accept complex boolean expressions with isPlanMode", () => {
      const result = validateExpression('turn.count("edit_file") > 0 && turn.lastIndex("bash#lint") == -1 && !isPlanMode()');
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

    it("should accept turn.countResult()", () => {
      const result = validateExpression('turn.countResult("bash", "error") > 0');
      expect(result.valid).toBe(true);
    });

    it("should accept literal true/false", () => {
      expect(validateExpression("true").valid).toBe(true);
      expect(validateExpression("false").valid).toBe(true);
    });

    it("should accept empty expression", () => {
      const result = validateExpression("");
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

    it("should reject seq.hasAny()", () => {
      const result = validateExpression('seq.hasAny(["bash", "edit_file"])');
      expect(result.valid).toBe(false);
    });

    it("should reject seq.lastIndexOf()", () => {
      const result = validateExpression('seq.lastIndexOf("bash#lint") == -1');
      expect(result.valid).toBe(false);
    });

    it("should reject seq.isPlanMode()", () => {
      const result = validateExpression("seq.isPlanMode()");
      expect(result.valid).toBe(false);
    });
  });

  describe("dangerous patterns", () => {
    it("should reject eval()", () => {
      const result = validateExpression('eval("malicious")');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("not allowed") || e.includes("Forbidden"))).toBe(true);
    });

    it("should reject Function constructor", () => {
      const result = validateExpression('Function("return 1")');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject require()", () => {
      const result = validateExpression('require("fs")');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject process access", () => {
      const result = validateExpression("process.exit()");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject fs access", () => {
      const result = validateExpression("fs.readFileSync()");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject __proto__", () => {
      const result = validateExpression("obj.__proto__");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject constructor", () => {
      const result = validateExpression("obj.constructor()");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("syntax errors", () => {
    it("should reject unbalanced parentheses", () => {
      const result = validateExpression('turn.count("bash"');
      expect(result.valid).toBe(false);
    });

    it("should reject unbalanced brackets", () => {
      const result = validateExpression('turn.count(["bash"');
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

    it("should evaluate turn.count() with multiple tools", () => {
      const mockSeq = createMockSequence([
        { tool: "bash", args: {}, result: "ok" },
        { tool: "bash", args: {}, result: "ok" },
        { tool: "edit_file", args: {}, result: "ok" },
      ]);
      const result = testCondition('turn.count("bash") == 2', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });

    it("should evaluate turn.lastIndex()", () => {
      const mockSeq = createMockSequence([
        { tool: "bash", args: { command: "pnpm lint" }, result: "ok" },
      ]);
      const result = testCondition('turn.lastIndex("bash#pnpm") != -1', mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
    });

    it("should evaluate turn.hadError()", () => {
      const mockSeq = createMockSequence([
        { tool: "bash", args: { command: "test" }, result: "Error: failed" },
      ]);
      const result = testCondition("turn.hadError()", mockSeq);
      expect(result.passed).toBe(true);
      expect(result.evaluatedValue).toBe(true);
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

describe("smokeTestExpression()", () => {
  it("should pass for valid expression", () => {
    const result = smokeTestExpression('turn.count("bash") > 0');
    expect(result.passed).toBe(true);
  });

  it("should pass for isPlanMode()", () => {
    const result = smokeTestExpression("isPlanMode()");
    expect(result.passed).toBe(true);
  });

  it("should evaluate to false for a syntax error (evaluateExpression swallows the jsep error)", () => {
    const result = smokeTestExpression("turn.count(");
    // evaluateExpression catches jsep errors and returns false, so the smoke
    // test reports passed:true with evaluatedValue:false (no throw).
    expect(result.passed).toBe(true);
    expect(result.evaluatedValue).toBe(false);
  });
});

describe("createMockSequence()", () => {
  it("should create empty sequence", () => {
    const seq = createMockSequence([]);
    expect(seq.turnCount()).toBe(0);
    expect(seq.sessionCount()).toBe(0);
  });

  it("should track events", () => {
    const seq = createMockSequence([
      { tool: "bash", args: { command: "test" }, result: "ok" },
    ]);
    expect(seq.turnCount("bash")).toBe(1);
  });

  it("should support turn.lastIndex()", () => {
    const seq = createMockSequence([
      { tool: "bash", args: { command: "pnpm lint" }, result: "ok" },
    ]);
    expect(seq.turnLastIndex("bash#pnpm lint")).not.toBe(-1);
    expect(seq.turnLastIndex("bash#test")).toBe(-1);
  });

  it("should support turn.count()", () => {
    const seq = createMockSequence([
      { tool: "bash", args: {}, result: "ok" },
      { tool: "bash", args: {}, result: "ok" },
      { tool: "edit_file", args: {}, result: "ok" },
    ]);
    expect(seq.turnCount("bash")).toBe(2);
    expect(seq.turnCount()).toBe(3);
  });

  it("should support session.count() across turns", () => {
    const seq = createMockSequence([
      { tool: "edit_file", args: { path: "a" }, result: "ok" },
    ]);
    seq.markPromptBoundary();
    seq.addEvent("edit_file", { path: "b" }, "ok");
    expect(seq.sessionCount("edit_file")).toBe(2);
    expect(seq.turnCount("edit_file")).toBe(1); // only current turn
  });

  it("should support turn.hadError()", () => {
    const seq = createMockSequence([
      { tool: "bash", args: { command: "test" }, result: "Error: failed" },
    ]);
    expect(seq.turnHadError()).toBe(true);
    expect(seq.turnHadError("bash")).toBe(true);
  });

  it("should support bash#prefix clause-splitting", () => {
    const seq = createMockSequence([
      { tool: "bash", args: { command: "pnpm lint && pnpm test" }, result: "ok" },
    ]);
    expect(seq.turnCount("bash#pnpm lint")).toBe(1);
    expect(seq.turnCount("bash#pnpm test")).toBe(1);
    expect(seq.turnCount("bash#lint")).toBe(0); // prefix not substring
  });
});
