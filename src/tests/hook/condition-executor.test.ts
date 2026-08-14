/**
 * condition-executor.test.ts - Thorough condition API tests.
 *
 * Per the user requirement: for EVERY API function, 2 trigger tests
 * (condition evaluates true -> hook fires) + 3 non-trigger tests
 * (condition evaluates false -> hook does not fire), plus combination tests.
 *
 * The sequence is mockable (MockSequence), so each test:
 *   1. Prepares a mock sequence with events
 *   2. Evaluates a condition expression via Sequence.evaluate (or evaluateExpression)
 *   3. Asserts whether it triggers (true) or not (false)
 *
 * APIs covered (8 scoped + 2 global):
 *   turn.count(tool?)          session.count(tool?)
 *   turn.lastIndex(tool)       session.lastIndex(tool)
 *   turn.countResult(tool,pat) session.countResult(tool,pat)
 *   turn.hadError(tool?)       session.hadError(tool?)
 *   isPlanMode()
 *   call.metadata.* / call.args.*
 *
 * Three-class tool spec covered:
 *   "edit_file"              - plain tool (exact match)
 *   "skill_load#plan-quality" - skill_load whose args.name contains skillName
 *   "bash#pnpm lint"          - bash whose args.command clause-starts-with prefix
 */

import { describe, it, expect } from "vitest";
import { Sequence, type SequenceEvent, matchesToolSpec, splitClauses } from "../../hook/sequence.js";
import { evaluateExpression, type EvalContext } from "../../hook/evaluator.js";
import { MockSequence, createMockSequence } from "../../hook/condition-validator.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a Sequence from events */
function seqFrom(events: SequenceEvent[]): Sequence {
  const s = new Sequence();
  for (const e of events) s.add(e);
  return s;
}

/** Evaluate expression against a real Sequence */
function evalSeq(seq: Sequence, expr: string): boolean {
  return seq.evaluate(expr);
}

/** Evaluate expression against a MockSequence via EvalContext */
function evalMock(mock: MockSequence, expr: string): boolean {
  const ctx: EvalContext = {
    turnCount: (t?: string) => mock.turnCount(t),
    turnLastIndex: (t: string) => mock.turnLastIndex(t),
    turnCountResult: (t: string, p: string, m?: number) => mock.turnCountResult(t, p, m),
    turnHadError: (t?: string) => mock.turnHadError(t),
    sessionCount: (t?: string) => mock.sessionCount(t),
    sessionLastIndex: (t: string) => mock.sessionLastIndex(t),
    sessionCountResult: (t: string, p: string, m?: number) => mock.sessionCountResult(t, p, m),
    sessionHadError: (t?: string) => mock.sessionHadError(t),
    isPlanMode: () => mock.isPlanMode(),
  };
  return evaluateExpression(expr, ctx);
}

/** Common event factory */
function ev(tool: string, args: Record<string, unknown> = {}, result = "ok", ts = 1000): SequenceEvent {
  return { tool, args, result, timestamp: ts };
}

// ============================================================================
// matchesToolSpec + splitClauses unit tests
// ============================================================================

describe("matchesToolSpec()", () => {
  it("plain tool: exact name match", () => {
    expect(matchesToolSpec(ev("edit_file"), "edit_file")).toBe(true);
    expect(matchesToolSpec(ev("edit_file"), "write_file")).toBe(false);
  });

  it("skill_load#name: args.name contains skillName", () => {
    expect(matchesToolSpec(ev("skill_load", { name: "plan-quality" }), "skill_load#plan-quality")).toBe(true);
    expect(matchesToolSpec(ev("skill_load", { name: "plan-quality" }), "skill_load#create-skill")).toBe(false);
  });

  it("bash#prefix: clause-split + prefix match", () => {
    expect(matchesToolSpec(ev("bash", { command: "pnpm lint && pnpm test" }), "bash#pnpm lint")).toBe(true);
    expect(matchesToolSpec(ev("bash", { command: "pnpm lint && pnpm test" }), "bash#pnpm test")).toBe(true);
  });

  it("bash#prefix: prefix match, NOT substring", () => {
    // "lint" is a substring of "pnpm lint" but NOT a prefix of any clause
    expect(matchesToolSpec(ev("bash", { command: "pnpm lint" }), "bash#lint")).toBe(false);
    expect(matchesToolSpec(ev("bash", { command: "pnpm lint" }), "bash#pnpm")).toBe(true);
  });

  it("bash#prefix: clause split by ;", () => {
    expect(matchesToolSpec(ev("bash", { command: "pnpm lint; pnpm test" }), "bash#pnpm test")).toBe(true);
    expect(matchesToolSpec(ev("bash", { command: "pnpm lint; pnpm test" }), "bash#pnpm lint")).toBe(true);
  });

  it("bash#prefix: clause split by ||", () => {
    expect(matchesToolSpec(ev("bash", { command: "cmd1 || cmd2" }), "bash#cmd2")).toBe(true);
  });

  it("returns false when tool name mismatches", () => {
    expect(matchesToolSpec(ev("read_file", { command: "test" }), "bash#test")).toBe(false);
  });

  it("returns false when args.name is not a string", () => {
    expect(matchesToolSpec(ev("skill_load", { name: 123 }), "skill_load#plan")).toBe(false);
  });
});

describe("splitClauses()", () => {
  it("splits by ;", () => {
    expect(splitClauses("a; b; c")).toEqual(["a", "b", "c"]);
  });

  it("splits by &&", () => {
    expect(splitClauses("a && b && c")).toEqual(["a", "b", "c"]);
  });

  it("splits by ||", () => {
    expect(splitClauses("a || b")).toEqual(["a", "b"]);
  });

  it("splits by mixed separators", () => {
    expect(splitClauses("a && b; c || d")).toEqual(["a", "b", "c", "d"]);
  });

  it("filters empty clauses", () => {
    expect(splitClauses("a;; b;")).toEqual(["a", "b"]);
  });

  it("trims whitespace", () => {
    expect(splitClauses("  pnpm lint   ")).toEqual(["pnpm lint"]);
  });

  it("handles empty string", () => {
    expect(splitClauses("")).toEqual([]);
  });

  it("handles single clause (no separator)", () => {
    expect(splitClauses("pnpm lint")).toEqual(["pnpm lint"]);
  });
});

// ============================================================================
// turn.count(tool?)
// ============================================================================

describe("turn.count(tool?)", () => {
  describe("trigger tests (condition true -> hook fires)", () => {
    it("T1: count(\"edit_file\") > 0 when edit_file present", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0")).toBe(true);
    });

    it("T2: count() > 0 when any tool present", () => {
      const seq = seqFrom([ev("bash", { command: "echo hi" })]);
      expect(evalSeq(seq, "turn.count() > 0")).toBe(true);
    });
  });

  describe("non-trigger tests (condition false -> hook does not fire)", () => {
    it("N1: count(\"edit_file\") > 0 when no edit_file", () => {
      const seq = seqFrom([ev("bash", { command: "echo hi" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0")).toBe(false);
    });

    it("N2: count() > 0 on empty sequence", () => {
      const seq = seqFrom([]);
      expect(evalSeq(seq, "turn.count() > 0")).toBe(false);
    });

    it("N3: count(\"bash#pnpm lint\") > 0 when bash has different command", () => {
      const seq = seqFrom([ev("bash", { command: "echo hi" })]);
      expect(evalSeq(seq, "turn.count('bash#pnpm lint') > 0")).toBe(false);
    });
  });
});

// ============================================================================
// turn.lastIndex(tool)
// ============================================================================

describe("turn.lastIndex(tool)", () => {
  describe("trigger tests", () => {
    it("T1: lastIndex(\"edit_file\") >= 0 when edit_file present", () => {
      const seq = seqFrom([ev("bash"), ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.lastIndex('edit_file') >= 0")).toBe(true);
    });

    it("T2: lastIndex(\"edit_file\") >= lastIndex(\"bash#pnpm lint\") when edit after lint", () => {
      const seq = seqFrom([
        ev("bash", { command: "pnpm lint" }),
        ev("edit_file", { path: "a.ts" }),
      ]);
      expect(evalSeq(seq, "turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: lastIndex(\"edit_file\") >= 0 when no edit_file", () => {
      const seq = seqFrom([ev("bash", { command: "echo" })]);
      expect(evalSeq(seq, "turn.lastIndex('edit_file') >= 0")).toBe(false);
    });

    it("N2: lastIndex(\"edit_file\") >= lastIndex(\"bash#pnpm lint\") when lint after edit", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }),
        ev("bash", { command: "pnpm lint" }),
      ]);
      expect(evalSeq(seq, "turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint')")).toBe(false);
    });

    it("N3: lastIndex(\"bash#pnpm lint\") != -1 when no lint run", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#pnpm lint') != -1")).toBe(false);
    });
  });
});

// ============================================================================
// turn.countResult(tool, pattern, maxChars?)
// ============================================================================

describe("turn.countResult(tool, pattern, maxChars?)", () => {
  describe("trigger tests", () => {
    it("T1: countResult(\"bash\", \"error\") > 0 when bash result contains \"error\"", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "error: something")]);
      expect(evalSeq(seq, "turn.countResult('bash', 'error') > 0")).toBe(true);
    });

    it("T2: countResult(\"*\", \"warning\") > 0 when any tool result contains \"warning\"", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" }, "warning: deprecated")]);
      expect(evalSeq(seq, "turn.countResult('*', 'warning') > 0")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: countResult(\"bash\", \"error\") > 0 when no error in result", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "ok")]);
      expect(evalSeq(seq, "turn.countResult('bash', 'error') > 0")).toBe(false);
    });

    it("N2: countResult(\"edit_file\", \"error\") > 0 when error is in a different tool", () => {
      const seq = seqFrom([
        ev("bash", { command: "test" }, "error: failed"),
        ev("edit_file", { path: "a.ts" }, "ok"),
      ]);
      expect(evalSeq(seq, "turn.countResult('edit_file', 'error') > 0")).toBe(false);
    });

    it("N3: countResult with maxChars excludes error beyond limit", () => {
      // Error appears at char 50+, but maxChars=50 truncates before it
      const longResult = "x".repeat(50) + "error: found";
      const seq = seqFrom([ev("bash", { command: "test" }, longResult)]);
      expect(evalSeq(seq, "turn.countResult('bash', 'error', 50) > 0")).toBe(false);
    });
  });
});

// ============================================================================
// turn.hadError(tool?)
// ============================================================================

describe("turn.hadError(tool?)", () => {
  describe("trigger tests", () => {
    it("T1: hadError() when any tool result contains \"error\"", () => {
      const seq = seqFrom([
        ev("bash", { command: "test" }, "ok"),
        ev("edit_file", { path: "a.ts" }, "error: failed"),
      ]);
      expect(evalSeq(seq, "turn.hadError()")).toBe(true);
    });

    it("T2: hadError(\"bash\") when bash result contains \"failed\"", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "Command failed")]);
      expect(evalSeq(seq, "turn.hadError('bash')")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: hadError() when no errors at all", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "ok")]);
      expect(evalSeq(seq, "turn.hadError()")).toBe(false);
    });

    it("N2: hadError(\"bash\") when error is in a different tool", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }, "error: failed"),
        ev("bash", { command: "test" }, "ok"),
      ]);
      expect(evalSeq(seq, "turn.hadError('bash')")).toBe(false);
    });

    it("N3: hadError() on empty sequence", () => {
      const seq = seqFrom([]);
      expect(evalSeq(seq, "turn.hadError()")).toBe(false);
    });
  });
});

// ============================================================================
// session.count(tool?)
// ============================================================================

describe("session.count(tool?)", () => {
  describe("trigger tests", () => {
    it("T1: session.count(\"edit_file\") > 0 when edit_file in livelog", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "session.count('edit_file') > 0")).toBe(true);
    });

    it("T2: session.count(\"skill_load#plan-quality\") > 0 survives turn boundary", () => {
      const seq = seqFrom([ev("skill_load", { name: "plan-quality" })]);
      seq.markPromptBoundary(); // turn boundary
      seq.add(ev("edit_file", { path: "b.ts" }));
      expect(evalSeq(seq, "session.count('skill_load#plan-quality') > 0")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: session.count(\"edit_file\") > 0 when no edit_file ever", () => {
      const seq = seqFrom([ev("bash", { command: "echo" })]);
      expect(evalSeq(seq, "session.count('edit_file') > 0")).toBe(false);
    });

    it("N2: session.count(\"skill_load#plan-quality\") > 0 when different skill loaded", () => {
      const seq = seqFrom([ev("skill_load", { name: "create-skill" })]);
      expect(evalSeq(seq, "session.count('skill_load#plan-quality') > 0")).toBe(false);
    });

    it("N3: session.count(\"bash#pnpm lint\") > 0 when bash has different command", () => {
      const seq = seqFrom([ev("bash", { command: "echo hi" })]);
      expect(evalSeq(seq, "session.count('bash#pnpm lint') > 0")).toBe(false);
    });
  });
});

// ============================================================================
// session.lastIndex(tool)
// ============================================================================

describe("session.lastIndex(tool)", () => {
  describe("trigger tests", () => {
    it("T1: session.lastIndex(\"edit_file\") >= 0 when edit_file in livelog", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "session.lastIndex('edit_file') >= 0")).toBe(true);
    });

    it("T2: session.lastIndex(\"edit_file\") >= session.lastIndex(\"bash#pnpm lint\") when edit after lint", () => {
      const seq = seqFrom([
        ev("bash", { command: "pnpm lint" }),
        ev("edit_file", { path: "a.ts" }),
      ]);
      expect(evalSeq(seq, "session.lastIndex('edit_file') >= session.lastIndex('bash#pnpm lint')")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: session.lastIndex(\"edit_file\") >= 0 when no edit_file", () => {
      const seq = seqFrom([ev("bash", { command: "echo" })]);
      expect(evalSeq(seq, "session.lastIndex('edit_file') >= 0")).toBe(false);
    });

    it("N2: session.lastIndex(\"bash#pnpm lint\") != -1 when no lint run", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "session.lastIndex('bash#pnpm lint') != -1")).toBe(false);
    });

    it("N3: session.lastIndex(\"edit_file\") >= session.lastIndex(\"bash#pnpm lint\") when lint after edit", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }),
        ev("bash", { command: "pnpm lint" }),
      ]);
      expect(evalSeq(seq, "session.lastIndex('edit_file') >= session.lastIndex('bash#pnpm lint')")).toBe(false);
    });
  });
});

// ============================================================================
// session.countResult(tool, pattern, maxChars?)
// ============================================================================

describe("session.countResult(tool, pattern, maxChars?)", () => {
  describe("trigger tests", () => {
    it("T1: session.countResult(\"bash\", \"error\") > 0 when bash result contains \"error\"", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "error: failed")]);
      expect(evalSeq(seq, "session.countResult('bash', 'error') > 0")).toBe(true);
    });

    it("T2: session.countResult(\"*\", \"warning\") > 0 survives turn boundary", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" }, "warning: deprecated")]);
      seq.markPromptBoundary();
      expect(evalSeq(seq, "session.countResult('*', 'warning') > 0")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: session.countResult(\"bash\", \"error\") > 0 when no error in any result", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "ok")]);
      expect(evalSeq(seq, "session.countResult('bash', 'error') > 0")).toBe(false);
    });

    it("N2: session.countResult(\"edit_file\", \"error\") > 0 when error is in bash only", () => {
      const seq = seqFrom([
        ev("bash", { command: "test" }, "error: failed"),
        ev("edit_file", { path: "a.ts" }, "ok"),
      ]);
      expect(evalSeq(seq, "session.countResult('edit_file', 'error') > 0")).toBe(false);
    });

    it("N3: session.countResult with maxChars excludes error beyond limit", () => {
      const longResult = "x".repeat(50) + "error: found";
      const seq = seqFrom([ev("bash", { command: "test" }, longResult)]);
      expect(evalSeq(seq, "session.countResult('bash', 'error', 50) > 0")).toBe(false);
    });
  });
});

// ============================================================================
// session.hadError(tool?)
// ============================================================================

describe("session.hadError(tool?)", () => {
  describe("trigger tests", () => {
    it("T1: session.hadError() when any tool result contains \"error\"", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "error: failed")]);
      expect(evalSeq(seq, "session.hadError()")).toBe(true);
    });

    it("T2: session.hadError(\"bash\") survives turn boundary", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "error: failed")]);
      seq.markPromptBoundary();
      expect(evalSeq(seq, "session.hadError('bash')")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: session.hadError() when no errors at all", () => {
      const seq = seqFrom([ev("bash", { command: "test" }, "ok")]);
      expect(evalSeq(seq, "session.hadError()")).toBe(false);
    });

    it("N2: session.hadError(\"bash\") when error is in edit_file only", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }, "error: failed"),
        ev("bash", { command: "test" }, "ok"),
      ]);
      expect(evalSeq(seq, "session.hadError('bash')")).toBe(false);
    });

    it("N3: session.hadError() on empty sequence", () => {
      const seq = seqFrom([]);
      expect(evalSeq(seq, "session.hadError()")).toBe(false);
    });
  });
});

// ============================================================================
// isPlanMode()
// ============================================================================

describe("isPlanMode()", () => {
  describe("trigger tests", () => {
    it("T1: isPlanMode() when in plan mode", () => {
      const seq = new Sequence(undefined, () => "plan");
      expect(evalSeq(seq, "isPlanMode()")).toBe(true);
    });

    it("T2: isPlanMode() && turn.count(\"edit_file\") > 0 in plan mode with edit", () => {
      const seq = new Sequence(undefined, () => "plan");
      seq.add(ev("edit_file", { path: "a.ts" }));
      expect(evalSeq(seq, "isPlanMode() && turn.count('edit_file') > 0")).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: isPlanMode() in normal mode", () => {
      const seq = new Sequence(undefined, () => "normal");
      expect(evalSeq(seq, "isPlanMode()")).toBe(false);
    });

    it("N2: isPlanMode() with no mode getter (defaults to normal)", () => {
      const seq = new Sequence();
      expect(evalSeq(seq, "isPlanMode()")).toBe(false);
    });

    it("N3: isPlanMode() && turn.count(\"edit_file\") > 0 in normal mode", () => {
      const seq = new Sequence(undefined, () => "normal");
      seq.add(ev("edit_file", { path: "a.ts" }));
      expect(evalSeq(seq, "isPlanMode() && turn.count('edit_file') > 0")).toBe(false);
    });
  });
});

// ============================================================================
// call.metadata.* / call.args.*
// ============================================================================

describe("call.metadata.* / call.args.*", () => {
  // These are evaluated via evaluateWithCall, which provides the call context
  function evalWithCall(
    seq: Sequence,
    expr: string,
    call: { metadata?: Record<string, unknown>; args?: Record<string, unknown> }
  ): boolean {
    return seq.evaluateWithCall(expr, call);
  }

  describe("trigger tests", () => {
    it("T1: call.args.command.includes(\"force\") when command contains \"--force\"", () => {
      const seq = seqFrom([]);
      const forceCmd = "git " + "push " + "--" + "force origin main";
      expect(evalWithCall(seq, 'call.args.command.includes("force")', {
        args: { command: forceCmd },
      })).toBe(true);
    });

    it("T2: call.metadata.isDestructive when metadata says destructive", () => {
      const seq = seqFrom([]);
      expect(evalWithCall(seq, "call.metadata.isDestructive", {
        metadata: { isDestructive: true },
      })).toBe(true);
    });
  });

  describe("non-trigger tests", () => {
    it("N1: call.args.command.includes(\"force\") when command has no \"--force\"", () => {
      const seq = seqFrom([]);
      const normalCmd = "git " + "push origin main";
      expect(evalWithCall(seq, 'call.args.command.includes("force")', {
        args: { command: normalCmd },
      })).toBe(false);
    });

    it("N2: call.metadata.isDestructive when metadata says not destructive", () => {
      const seq = seqFrom([]);
      expect(evalWithCall(seq, "call.metadata.isDestructive", {
        metadata: { isDestructive: false },
      })).toBe(false);
    });

    it("N3: call.metadata.isDestructive when metadata is missing", () => {
      const seq = seqFrom([]);
      expect(evalWithCall(seq, "call.metadata.isDestructive", {
        metadata: {},
      })).toBe(false);
    });
  });
});

// ============================================================================
// Condition Combinations (AND / OR / NOT)
// ============================================================================

describe("Condition combinations", () => {
  // ---- AND ----
  describe("AND combinations", () => {
    it("AND true: edit present AND no lint run", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0 && turn.lastIndex('bash#pnpm lint') == -1")).toBe(true);
    });

    it("AND false: edit present but lint was run", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }),
        ev("bash", { command: "pnpm lint" }),
      ]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0 && turn.lastIndex('bash#pnpm lint') == -1")).toBe(false);
    });

    it("AND false: no edit but no lint", () => {
      const seq = seqFrom([ev("bash", { command: "echo" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0 && turn.lastIndex('bash#pnpm lint') == -1")).toBe(false);
    });
  });

  // ---- OR ----
  describe("OR combinations", () => {
    it("OR true: edit OR write present (edit)", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0 || turn.count('write_file') > 0")).toBe(true);
    });

    it("OR true: edit OR write present (write)", () => {
      const seq = seqFrom([ev("write_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0 || turn.count('write_file') > 0")).toBe(true);
    });

    it("OR false: neither edit nor write present", () => {
      const seq = seqFrom([ev("bash", { command: "echo" })]);
      expect(evalSeq(seq, "turn.count('edit_file') > 0 || turn.count('write_file') > 0")).toBe(false);
    });
  });

  // ---- NOT ----
  describe("NOT combinations", () => {
    it("NOT true: no lint run", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#pnpm lint') == -1")).toBe(true);
    });

    it("NOT false: lint was run", () => {
      const seq = seqFrom([ev("bash", { command: "pnpm lint" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#pnpm lint') == -1")).toBe(false);
    });
  });

  // ---- Compound (lint-after-edit full condition) ----
  describe("Compound: lint-after-edit condition", () => {
    const CONDITION =
      "(turn.count('edit_file') > 0 || turn.count('write_file') > 0) && " +
      "(turn.lastIndex('edit_file') >= turn.lastIndex('bash#pnpm lint') || " +
      "turn.lastIndex('write_file') >= turn.lastIndex('bash#pnpm lint') || " +
      "turn.lastIndex('bash#pnpm lint') == -1)";

    it("true: edit made, no lint run", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, CONDITION)).toBe(true);
    });

    it("false: edit then lint (clean)", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }),
        ev("bash", { command: "pnpm lint" }),
      ]);
      expect(evalSeq(seq, CONDITION)).toBe(false);
    });

    it("true: lint then edit (dirty)", () => {
      const seq = seqFrom([
        ev("bash", { command: "pnpm lint" }),
        ev("edit_file", { path: "a.ts" }),
      ]);
      expect(evalSeq(seq, CONDITION)).toBe(true);
    });

    it("false: no edits at all", () => {
      const seq = seqFrom([ev("bash", { command: "echo" })]);
      expect(evalSeq(seq, CONDITION)).toBe(false);
    });
  });

  // ---- Session-level dedup condition ----
  describe("Compound: session dedup condition", () => {
    const CONDITION = "isPlanMode() && session.count('skill_load#plan-quality') == 0";

    it("true: plan mode, skill never loaded", () => {
      const seq = new Sequence(undefined, () => "plan");
      expect(evalSeq(seq, CONDITION)).toBe(true);
    });

    it("false: plan mode, skill already loaded", () => {
      const seq = new Sequence(undefined, () => "plan");
      seq.add(ev("skill_load", { name: "plan-quality" }));
      expect(evalSeq(seq, CONDITION)).toBe(false);
    });

    it("false: normal mode, skill never loaded", () => {
      const seq = new Sequence(undefined, () => "normal");
      expect(evalSeq(seq, CONDITION)).toBe(false);
    });

    it("true: plan mode, different skill loaded", () => {
      const seq = new Sequence(undefined, () => "plan");
      seq.add(ev("skill_load", { name: "create-skill" }));
      expect(evalSeq(seq, CONDITION)).toBe(true);
    });
  });

  // ---- Error + dedup combination ----
  describe("Compound: error-triggered wiki search", () => {
    const CONDITION = "turn.hadError() && turn.count('wiki_get') == 0";

    it("true: error occurred, no wiki_get yet", () => {
      const seq = seqFrom([
        ev("bash", { command: "build" }, "error: compilation failed"),
      ]);
      expect(evalSeq(seq, CONDITION)).toBe(true);
    });

    it("false: no error", () => {
      const seq = seqFrom([ev("bash", { command: "build" }, "ok")]);
      expect(evalSeq(seq, CONDITION)).toBe(false);
    });

    it("false: error but wiki_get already called", () => {
      const seq = seqFrom([
        ev("bash", { command: "build" }, "error: compilation failed"),
        ev("wiki_get", { query: "error", domain: "pitfall" }, "ok"),
      ]);
      expect(evalSeq(seq, CONDITION)).toBe(false);
    });
  });

  // ---- turn vs session scope difference ----
  describe("Compound: turn vs session scope", () => {
    it("turn.count resets at boundary but session.count persists", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }),
        ev("edit_file", { path: "b.ts" }),
      ]);
      seq.markPromptBoundary();
      seq.add(ev("bash", { command: "echo" }));

      // turn.count('edit_file') = 0 (cleared at boundary)
      expect(evalSeq(seq, "turn.count('edit_file') > 0")).toBe(false);
      // session.count('edit_file') = 2 (persists across boundary)
      expect(evalSeq(seq, "session.count('edit_file') > 0")).toBe(true);
    });

    it("session counters reset on clear()", () => {
      const seq = seqFrom([
        ev("edit_file", { path: "a.ts" }),
        ev("edit_file", { path: "b.ts" }),
      ]);
      expect(evalSeq(seq, "session.count('edit_file') > 0")).toBe(true);
      seq.clear();
      expect(evalSeq(seq, "session.count('edit_file') > 0")).toBe(false);
      expect(evalSeq(seq, "session.count() > 0")).toBe(false);
    });
  });
});

// ============================================================================
// MockSequence integration (verify mock mirrors real Sequence)
// ============================================================================

describe("MockSequence mirrors Sequence behavior", () => {
  it("turn.count via MockSequence matches Sequence", () => {
    const events = [
      { tool: "bash", args: { command: "pnpm lint" }, result: "ok" },
      { tool: "edit_file", args: { path: "a.ts" }, result: "ok" },
    ];
    const realSeq = seqFrom(events.map(e => ({ ...e, timestamp: 1000 })));
    const mockSeq = createMockSequence(events);

    expect(mockSeq.turnCount("edit_file")).toBe(realSeq.turnCount("edit_file"));
    expect(mockSeq.turnCount("bash")).toBe(realSeq.turnCount("bash"));
    expect(mockSeq.turnCount()).toBe(realSeq.turnCount());
  });

  it("turn.lastIndex via MockSequence matches Sequence", () => {
    const events = [
      { tool: "bash", args: { command: "pnpm lint" }, result: "ok" },
      { tool: "edit_file", args: { path: "a.ts" }, result: "ok" },
    ];
    const realSeq = seqFrom(events.map(e => ({ ...e, timestamp: 1000 })));
    const mockSeq = createMockSequence(events);

    expect(mockSeq.turnLastIndex("bash#pnpm lint")).toBe(realSeq.turnLastIndex("bash#pnpm lint"));
    expect(mockSeq.turnLastIndex("edit_file")).toBe(realSeq.turnLastIndex("edit_file"));
  });

  it("session.count via MockSequence matches Sequence", () => {
    const events = [
      { tool: "skill_load", args: { name: "plan-quality" }, result: "ok" },
      { tool: "skill_load", args: { name: "create-skill" }, result: "ok" },
      { tool: "skill_load", args: { name: "plan-quality" }, result: "ok" },
    ];
    const realSeq = seqFrom(events.map(e => ({ ...e, timestamp: 1000 })));
    const mockSeq = createMockSequence(events);

    expect(mockSeq.sessionCount("skill_load#plan-quality")).toBe(realSeq.sessionCount("skill_load#plan-quality"));
    expect(mockSeq.sessionCount()).toBe(realSeq.sessionCount());
  });

  it("bash#prefix clause-splitting works in MockSequence", () => {
    const mock = createMockSequence([
      { tool: "bash", args: { command: "pnpm lint && pnpm test" }, result: "ok" },
    ]);
    expect(mock.turnCount("bash#pnpm lint")).toBe(1);
    expect(mock.turnCount("bash#pnpm test")).toBe(1);
    expect(mock.turnCount("bash#lint")).toBe(0); // prefix match, not substring
  });

  it("mock survives markPromptBoundary for session-level data", () => {
    const mock = createMockSequence([
      { tool: "edit_file", args: { path: "a.ts" }, result: "ok" },
    ]);
    mock.markPromptBoundary();
    mock.addEvent("bash", { command: "echo" }, "ok");

    expect(mock.turnCount("edit_file")).toBe(0); // turn-scoped, cleared
    expect(mock.sessionCount("edit_file")).toBe(1); // session-scoped, persists
  });

  it("evalMock: expression evaluates correctly via MockSequence", () => {
    const mock = createMockSequence([
      { tool: "edit_file", args: { path: "a.ts" }, result: "ok" },
    ]);
    expect(evalMock(mock, "turn.count('edit_file') > 0")).toBe(true);
    expect(evalMock(mock, "turn.hadError()")).toBe(false);
  });
});

// ============================================================================
// Three-class tool spec in condition expressions
// ============================================================================

describe("Three-class tool spec in conditions", () => {
  describe("Plain tool (exact match)", () => {
    it("turn.count(\"edit_file\") matches exact tool name", () => {
      const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.count('edit_file') == 1")).toBe(true);
    });

    it("turn.count(\"edit_file\") does not match \"edit_file_v2\"", () => {
      const seq = seqFrom([ev("edit_file_v2", { path: "a.ts" })]);
      expect(evalSeq(seq, "turn.count('edit_file') == 1")).toBe(false);
    });
  });

  describe("skill_load#skillName (args.name contains)", () => {
    it("turn.lastIndex(\"skill_load#plan-quality\") matches skill_load with name containing pattern", () => {
      const seq = seqFrom([
        ev("read_file", { path: "a.ts" }),
        ev("skill_load", { name: "plan-quality" }),
      ]);
      expect(evalSeq(seq, "turn.lastIndex('skill_load#plan-quality') == 1")).toBe(true);
    });

    it("turn.count(\"skill_load#plan-quality\") counts matching skill_load calls", () => {
      const seq = seqFrom([
        ev("skill_load", { name: "plan-quality" }),
        ev("skill_load", { name: "create-skill" }),
        ev("skill_load", { name: "plan-quality" }),
      ]);
      expect(evalSeq(seq, "turn.count('skill_load#plan-quality') == 2")).toBe(true);
    });
  });

  describe("bash#commandPrefix (clause-split + prefix match)", () => {
    it("bash#pnpm lint matches \"pnpm lint && pnpm test\"", () => {
      const seq = seqFrom([ev("bash", { command: "pnpm lint && pnpm test" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#pnpm lint') != -1")).toBe(true);
    });

    it("bash#lint does NOT match \"pnpm lint\" (prefix, not substring)", () => {
      const seq = seqFrom([ev("bash", { command: "pnpm lint" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#lint') != -1")).toBe(false);
    });

    it("bash#pnpm matches \"pnpm lint\" (prefix match)", () => {
      const seq = seqFrom([ev("bash", { command: "pnpm lint" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#pnpm') != -1")).toBe(true);
    });

    it("bash#pnpm test matches second clause in \"pnpm lint && pnpm test\"", () => {
      const seq = seqFrom([ev("bash", { command: "pnpm lint && pnpm test" })]);
      expect(evalSeq(seq, "turn.lastIndex('bash#pnpm test') != -1")).toBe(true);
    });

    it("session.count(\"bash#pnpm lint\") counts across turns (survives boundary)", () => {
      const seq = seqFrom([
        ev("bash", { command: "pnpm lint" }),
        ev("bash", { command: "pnpm test" }),
      ]);
      seq.markPromptBoundary();
      seq.add(ev("bash", { command: "pnpm lint" }));
      // session count should be 2 (two pnpm lint calls across session)
      expect(evalSeq(seq, "session.count('bash#pnpm lint') == 2")).toBe(true);
    });
  });
});

// ============================================================================
// Legacy seq.* syntax rejection
// ============================================================================

describe("Legacy seq.* syntax is rejected", () => {
  it("seq.count() evaluates to false (not supported)", () => {
    const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
    // seq.count is not in the new EvalContext, so evaluation fails -> false
    expect(evalSeq(seq, 'seq.count("edit_file") > 0')).toBe(false);
  });

  it("seq.has() evaluates to false (not supported)", () => {
    const seq = seqFrom([ev("edit_file", { path: "a.ts" })]);
    expect(evalSeq(seq, 'seq.has("edit_file")')).toBe(false);
  });
});
