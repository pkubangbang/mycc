/**
 * Tests for sequence.ts
 *
 * Tests cover:
 * - Sequence basic operations (add, getEvents, clear, markPromptBoundary)
 * - Turn-scoped API: turnCount, turnLastIndex, turnCountResult, turnHadError
 * - Session-scoped API: sessionCount, sessionLastIndex, sessionCountResult, sessionHadError
 * - isPlanMode()
 * - evaluate() with various expressions
 * - Edge cases and error handling
 * - Three-class tool spec matching
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Sequence } from "../hook/sequence.js";

// ============================================================================
// Sequence Basic Operations
// ============================================================================

describe("Sequence", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  describe("add() and getEvents()", () => {
    it("should add events to sequence", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
      expect(seq.getEvents()).toHaveLength(1);
    });

    it("should return copy of events array", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
      const events = seq.getEvents();
      events.push({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
      expect(seq.getEvents()).toHaveLength(1); // Original unchanged
    });
  });

  describe("clear()", () => {
    it("should clear all events and session counters", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
      expect(seq.getEvents()).toHaveLength(2);

      seq.clear();
      expect(seq.getEvents()).toHaveLength(0);
      expect(seq.sessionCount()).toBe(0);
    });
  });

  describe("markPromptBoundary()", () => {
    it("should clear turn events but preserve session counters", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });

      seq.markPromptBoundary();

      expect(seq.getEvents()).toHaveLength(0);
      expect(seq.sessionCount()).toBe(2);
    });
  });
});

// ============================================================================
// turn.count(tool?)
// ============================================================================

describe("turn.count(tool?)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return 0 for empty sequence", () => {
    expect(seq.turnCount()).toBe(0);
    expect(seq.turnCount("bash")).toBe(0);
  });

  it("should count all tools when no arg", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "read_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnCount()).toBe(3);
  });

  it("should count specific tool", () => {
    seq.add({ tool: "bash", args: { command: "t1" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "t2" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnCount("bash")).toBe(2);
    expect(seq.turnCount("edit_file")).toBe(1);
    expect(seq.turnCount("read_file")).toBe(0);
  });

  it("should count with bash#prefix (clause-split + prefix match)", () => {
    seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "pnpm test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnCount("bash#pnpm")).toBe(2);
    expect(seq.turnCount("bash#pnpm lint")).toBe(1);
    expect(seq.turnCount("bash#pnpm test")).toBe(1);
    expect(seq.turnCount("bash#lint")).toBe(0); // prefix not substring
  });

  it("should count with skill_load#name (args.name contains)", () => {
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "skill_load", args: { name: "create-skill" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnCount("skill_load#plan-quality")).toBe(1);
    expect(seq.turnCount("skill_load#create-skill")).toBe(1);
    expect(seq.turnCount("skill_load#nonexistent")).toBe(0);
  });
});

// ============================================================================
// turn.lastIndex(tool)
// ============================================================================

describe("turn.lastIndex(tool)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return -1 for empty sequence", () => {
    expect(seq.turnLastIndex("bash")).toBe(-1);
  });

  it("should return index of last matching tool", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnLastIndex("bash")).toBe(0);
    expect(seq.turnLastIndex("edit_file")).toBe(1);
  });

  it("should return -1 for non-existent tool", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnLastIndex("write_file")).toBe(-1);
  });

  it("should handle bash#prefix (clause-split + prefix match)", () => {
    seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnLastIndex("bash#lint")).toBe(-1); // prefix not substring
    expect(seq.turnLastIndex("bash#pnpm")).toBe(0);
    expect(seq.turnLastIndex("bash#pnpm lint")).toBe(0);
  });

  it("should handle skill_load#name", () => {
    seq.add({ tool: "read_file", args: { path: "a" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnLastIndex("skill_load#plan-quality")).toBe(1);
    expect(seq.turnLastIndex("skill_load#create-skill")).toBe(-1);
  });

  it("should handle edge cases: non-string command and missing command", () => {
    seq.add({ tool: "bash", args: { command: 123 }, result: "ok", timestamp: Date.now() });
    expect(seq.turnLastIndex("bash#test")).toBe(-1);

    seq.add({ tool: "bash", args: { intent: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnLastIndex("bash#test")).toBe(-1);
  });
});

// ============================================================================
// turn.countResult(tool, pattern, maxChars?)
// ============================================================================

describe("turn.countResult(tool, pattern, maxChars?)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return 0 for empty sequence", () => {
    expect(seq.turnCountResult("bash", "error")).toBe(0);
  });

  it("should count results containing pattern for specific tool", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "test2" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "a" }, result: "error: something", timestamp: Date.now() });
    expect(seq.turnCountResult("bash", "error")).toBe(1);
    expect(seq.turnCountResult("edit_file", "error")).toBe(1);
  });

  it("should count results containing pattern for all tools with *", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "a" }, result: "error: something", timestamp: Date.now() });
    expect(seq.turnCountResult("*", "error")).toBe(2);
  });

  it("should respect maxChars limit", () => {
    const longResult = "x".repeat(50) + "error: found";
    seq.add({ tool: "bash", args: { command: "test" }, result: longResult, timestamp: Date.now() });
    expect(seq.turnCountResult("bash", "error", 50)).toBe(0);
    expect(seq.turnCountResult("bash", "error", 100)).toBe(1);
  });

  it("should support bash#prefix tool spec", () => {
    seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "error: failed", timestamp: Date.now() });
    expect(seq.turnCountResult("bash#pnpm", "error")).toBe(1);
    expect(seq.turnCountResult("bash#test", "error")).toBe(0);
  });
});

// ============================================================================
// turn.hadError(tool?)
// ============================================================================

describe("turn.hadError(tool?)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return false for empty sequence", () => {
    expect(seq.turnHadError()).toBe(false);
  });

  it("should return false when no error events", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnHadError()).toBe(false);
  });

  it("should detect error in any tool result", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "fail" }, result: "Error: Command failed", timestamp: Date.now() });
    expect(seq.turnHadError()).toBe(true);
  });

  it("should detect error in specific tool when filtered", () => {
    seq.add({ tool: "edit_file", args: { path: "a" }, result: "error: failed", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.turnHadError("edit_file")).toBe(true);
    expect(seq.turnHadError("bash")).toBe(false);
  });

  it("should support bash#prefix tool spec", () => {
    seq.add({ tool: "bash", args: { command: "pnpm build" }, result: "error: failed", timestamp: Date.now() });
    expect(seq.turnHadError("bash#pnpm")).toBe(true);
    expect(seq.turnHadError("bash#pnpm test")).toBe(false);
  });

  it("should detect 'failed' as well as 'error'", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "Build failed", timestamp: Date.now() });
    expect(seq.turnHadError()).toBe(true);
  });
});

// ============================================================================
// session.count(tool?)
// ============================================================================

describe("session.count(tool?)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return 0 for empty sequence", () => {
    expect(seq.sessionCount()).toBe(0);
    expect(seq.sessionCount("bash")).toBe(0);
  });

  it("should count all tools when no arg", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.sessionCount()).toBe(2);
  });

  it("should count specific tool across turns (survives markPromptBoundary)", () => {
    seq.add({ tool: "bash", args: { command: "t1" }, result: "ok", timestamp: 1000 });
    seq.add({ tool: "bash", args: { command: "t2" }, result: "ok", timestamp: 2000 });
    seq.markPromptBoundary();
    seq.add({ tool: "bash", args: { command: "t3" }, result: "ok", timestamp: 3000 });
    expect(seq.sessionCount("bash")).toBe(3);
  });

  it("should count with bash#prefix (clause-split + prefix match)", () => {
    seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "pnpm test" }, result: "ok", timestamp: Date.now() });
    expect(seq.sessionCount("bash#pnpm lint")).toBe(1);
    expect(seq.sessionCount("bash#pnpm")).toBe(2);
    expect(seq.sessionCount("bash#lint")).toBe(0); // prefix not substring
  });

  it("should count with skill_load#name across turns", () => {
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: 1000 });
    seq.markPromptBoundary();
    seq.add({ tool: "skill_load", args: { name: "plan-quality" }, result: "ok", timestamp: 2000 });
    expect(seq.sessionCount("skill_load#plan-quality")).toBe(2);
  });

  it("should reset on clear()", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.sessionCount("bash")).toBe(1);
    seq.clear();
    expect(seq.sessionCount("bash")).toBe(0);
    expect(seq.sessionCount()).toBe(0);
  });
});

// ============================================================================
// session.lastIndex(tool)
// ============================================================================

describe("session.lastIndex(tool)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return -1 for empty sequence", () => {
    expect(seq.sessionLastIndex("bash")).toBe(-1);
  });

  it("should return index of last matching tool in livelog", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.sessionLastIndex("bash")).toBe(0);
    expect(seq.sessionLastIndex("edit_file")).toBe(1);
  });

  it("should index into session log across turns (survives markPromptBoundary)", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: 1000 });
    seq.add({ tool: "edit_file", args: { path: "a" }, result: "ok", timestamp: 2000 });
    seq.markPromptBoundary();
    seq.add({ tool: "bash", args: { command: "test2" }, result: "ok", timestamp: 3000 });
    // session index is relative to session start, not turn start
    // session log has 3 entries: bash(0), edit_file(1), bash(2)
    expect(seq.sessionLastIndex("bash")).toBe(2);
    expect(seq.sessionLastIndex("edit_file")).toBe(1);
  });

  it("should handle bash#prefix", () => {
    seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: Date.now() });
    expect(seq.sessionLastIndex("bash#pnpm lint")).toBe(0);
    expect(seq.sessionLastIndex("bash#lint")).toBe(-1);
  });
});

// ============================================================================
// session.countResult(tool, pattern, maxChars?)
// ============================================================================

describe("session.countResult(tool, pattern, maxChars?)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return 0 for empty sequence", () => {
    expect(seq.sessionCountResult("bash", "error")).toBe(0);
  });

  it("should count results containing pattern across entire session", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: 1000 });
    seq.markPromptBoundary();
    seq.add({ tool: "bash", args: { command: "test2" }, result: "error: another", timestamp: 2000 });
    expect(seq.sessionCountResult("bash", "error")).toBe(2);
  });

  it("should count results containing pattern for all tools with *", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: Date.now() });
    seq.add({ tool: "edit_file", args: { path: "a" }, result: "error: something", timestamp: Date.now() });
    expect(seq.sessionCountResult("*", "error")).toBe(2);
  });

  it("should respect maxChars limit", () => {
    const longResult = "x".repeat(50) + "error: found";
    seq.add({ tool: "bash", args: { command: "test" }, result: longResult, timestamp: Date.now() });
    expect(seq.sessionCountResult("bash", "error", 50)).toBe(0);
    expect(seq.sessionCountResult("bash", "error", 100)).toBe(1);
  });
});

// ============================================================================
// session.hadError(tool?)
// ============================================================================

describe("session.hadError(tool?)", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  it("should return false for empty sequence", () => {
    expect(seq.sessionHadError()).toBe(false);
  });

  it("should detect error across turns (survives markPromptBoundary)", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: 1000 });
    seq.markPromptBoundary();
    expect(seq.sessionHadError()).toBe(true);
  });

  it("should detect error in specific tool when filtered", () => {
    seq.add({ tool: "edit_file", args: { path: "a" }, result: "error: failed", timestamp: Date.now() });
    seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
    expect(seq.sessionHadError("edit_file")).toBe(true);
    expect(seq.sessionHadError("bash")).toBe(false);
  });

  it("should reset on clear()", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: Date.now() });
    expect(seq.sessionHadError()).toBe(true);
    seq.clear();
    expect(seq.sessionHadError()).toBe(false);
  });

  it("should detect 'failed' as well as 'error'", () => {
    seq.add({ tool: "bash", args: { command: "test" }, result: "Build failed", timestamp: Date.now() });
    expect(seq.sessionHadError()).toBe(true);
  });
});

// ============================================================================
// Sequence.evaluate() with expressions
// ============================================================================

describe("Sequence.evaluate()", () => {
  let seq: Sequence;

  beforeEach(() => {
    seq = new Sequence();
  });

  describe("turn.count()", () => {
    it("should evaluate turn.count() expression", () => {
      seq.add({ tool: "bash", args: { command: "test1" }, result: "ok", timestamp: Date.now() });
      seq.add({ tool: "bash", args: { command: "test2" }, result: "ok", timestamp: Date.now() });
      seq.add({ tool: "bash", args: { command: "test3" }, result: "ok", timestamp: Date.now() });

      expect(seq.evaluate('turn.count("bash") === 3')).toBe(true);
      expect(seq.evaluate('turn.count("bash") > 2')).toBe(true);
      expect(seq.evaluate('turn.count() === 3')).toBe(true);
    });
  });

  describe("turn.lastIndex()", () => {
    it("should evaluate turn.lastIndex() expression with command pattern", () => {
      seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: Date.now() });
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });

      expect(seq.evaluate('turn.lastIndex("bash#pnpm lint") != -1')).toBe(true);
      expect(seq.evaluate('turn.lastIndex("bash#test") == -1')).toBe(true);
    });

    it("should evaluate lastIndex comparison", () => {
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: 2000 });

      expect(seq.evaluate('turn.lastIndex("edit_file") >= turn.lastIndex("bash#pnpm lint")')).toBe(false);
    });
  });

  describe("turn.hadError()", () => {
    it("should evaluate turn.hadError() expression", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: Date.now() });
      expect(seq.evaluate("turn.hadError()")).toBe(true);
    });

    it("should return false when no error", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: Date.now() });
      expect(seq.evaluate("turn.hadError()")).toBe(false);
    });
  });

  describe("turn.countResult()", () => {
    it("should evaluate turn.countResult() expression", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: Date.now() });
      expect(seq.evaluate('turn.countResult("bash", "error") > 0')).toBe(true);
    });
  });

  describe("session.count()", () => {
    it("should evaluate session.count() expression", () => {
      seq.add({ tool: "edit_file", args: { path: "a" }, result: "ok", timestamp: 1000 });
      seq.markPromptBoundary();
      seq.add({ tool: "edit_file", args: { path: "b" }, result: "ok", timestamp: 2000 });
      expect(seq.evaluate('session.count("edit_file") == 2')).toBe(true);
    });
  });

  describe("session.lastIndex()", () => {
    it("should evaluate session.lastIndex() expression", () => {
      seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: 1000 });
      seq.markPromptBoundary();
      seq.add({ tool: "edit_file", args: { path: "a" }, result: "ok", timestamp: 2000 });
      expect(seq.evaluate('session.lastIndex("edit_file") >= session.lastIndex("bash#pnpm lint")')).toBe(true);
    });
  });

  describe("session.hadError()", () => {
    it("should evaluate session.hadError() expression", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "error: failed", timestamp: 1000 });
      seq.markPromptBoundary();
      expect(seq.evaluate("session.hadError()")).toBe(true);
    });
  });

  describe("complex expressions", () => {
    it("should evaluate boolean AND", () => {
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
      seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: Date.now() });

      expect(
        seq.evaluate('turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm lint") != -1')
      ).toBe(true);
    });

    it("should evaluate boolean OR", () => {
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });

      expect(
        seq.evaluate('turn.count("edit_file") > 0 || turn.count("write_file") > 0')
      ).toBe(true);
    });

    it("should evaluate negation", () => {
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });

      expect(seq.evaluate('turn.lastIndex("bash#pnpm lint") == -1')).toBe(true);
    });

    it("should evaluate complex condition", () => {
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "bash", args: { command: "pnpm test" }, result: "ok", timestamp: 2000 });

      const expr = 'turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm lint") == -1 && turn.count("bash") >= 1';
      expect(seq.evaluate(expr)).toBe(true);
    });
  });

  describe("literal values", () => {
    it("should evaluate true", () => {
      expect(seq.evaluate("true")).toBe(true);
    });

    it("should evaluate false", () => {
      expect(seq.evaluate("false")).toBe(false);
    });
  });

  describe("error handling", () => {
    it("should return false on syntax error", () => {
      expect(seq.evaluate("turn.count(")).toBe(false);
    });

    it("should return false on undefined function", () => {
      expect(seq.evaluate("turn.nonexistent()")).toBe(false);
    });

    it("should return false on legacy seq.* syntax", () => {
      seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });
      expect(seq.evaluate('seq.has("edit_file")')).toBe(false);
    });
  });
});

// ============================================================================
// hasSkillInConversation()
// ============================================================================

describe("Sequence.hasSkillInConversation()", () => {
  it("should return false without triologue", () => {
    const seq = new Sequence();
    expect(seq.hasSkillInConversation("test-skill")).toBe(false);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Sequence Integration Tests", () => {
  it("should support realistic pre-commit hook scenario", () => {
    const seq = new Sequence();

    // User edits some files
    seq.add({ tool: "edit_file", args: { path: "src/test.ts" }, result: "ok", timestamp: 1000 });
    seq.add({ tool: "edit_file", args: { path: "src/util.ts" }, result: "ok", timestamp: 2000 });

    // Condition: files edited and no lint run yet
    const shouldLint = seq.evaluate(
      'turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm lint") == -1'
    );
    expect(shouldLint).toBe(true);

    // Run lint
    seq.add({ tool: "bash", args: { command: "pnpm lint" }, result: "ok", timestamp: 3000 });

    // Now condition should be false
    const shouldLintNow = seq.evaluate(
      'turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm lint") == -1'
    );
    expect(shouldLintNow).toBe(false);
  });

  it("should support error-triggered wiki search", () => {
    const seq = new Sequence();

    // No errors yet
    expect(seq.evaluate("turn.hadError() && turn.count('wiki_get') == 0")).toBe(false);

    // An error occurs
    seq.add({
      tool: "bash",
      args: { command: "pnpm build" },
      result: "Error: TypeScript compilation failed",
      timestamp: 1000,
    });

    // Should search wiki
    const shouldSearchWiki = seq.evaluate(
      "turn.hadError() && turn.count('wiki_get') == 0"
    );
    expect(shouldSearchWiki).toBe(true);

    // Wiki search done
    seq.add({
      tool: "wiki_get",
      args: { query: "typescript error", domain: "pitfall" },
      result: "ok",
      timestamp: 2000,
    });

    // Should not search again
    const shouldSearchAgain = seq.evaluate(
      "turn.hadError() && turn.count('wiki_get') == 0"
    );
    expect(shouldSearchAgain).toBe(false);
  });

  it("should count tool occurrences correctly", () => {
    const seq = new Sequence();

    // Multiple bash calls
    for (let i = 0; i < 5; i++) {
      seq.add({ tool: "bash", args: { command: `echo ${i}` }, result: "ok", timestamp: i * 1000 });
    }

    // Check count
    expect(seq.evaluate('turn.count("bash") >= 3')).toBe(true);
    expect(seq.evaluate('turn.count("bash") >= 5')).toBe(true);
    expect(seq.evaluate('turn.count("bash") > 5')).toBe(false);
  });
});

// ============================================================================
// isPlanMode()
// ============================================================================

describe("isPlanMode()", () => {
  it("should return false when mode getter not provided", () => {
    const seq = new Sequence();
    expect(seq.isPlanMode()).toBe(false);
  });

  it("should return true when in plan mode", () => {
    const seq = new Sequence(undefined, () => "plan");
    expect(seq.isPlanMode()).toBe(true);
  });

  it("should return false when in normal mode", () => {
    const seq = new Sequence(undefined, () => "normal");
    expect(seq.isPlanMode()).toBe(false);
  });
});

describe("Sequence.evaluate() with isPlanMode", () => {
  it("should evaluate isPlanMode() expression", () => {
    const seq = new Sequence(undefined, () => "plan");
    expect(seq.evaluate("isPlanMode()")).toBe(true);
  });

  it("should prevent hook in plan mode", () => {
    const seq = new Sequence(undefined, () => "plan");
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });

    expect(seq.evaluate('turn.count("edit_file") > 0 && !isPlanMode()')).toBe(false);
  });

  it("should allow hook in normal mode", () => {
    const seq = new Sequence(undefined, () => "normal");
    seq.add({ tool: "edit_file", args: { path: "test" }, result: "ok", timestamp: Date.now() });

    expect(seq.evaluate('turn.count("edit_file") > 0 && !isPlanMode()')).toBe(true);
  });
});
