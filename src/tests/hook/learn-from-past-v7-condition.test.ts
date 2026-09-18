/**
 * Verifies the hand-applied v7 condition for `learn-from-past` is valid
 * (on-disk validator accepts totalTurns()) and semantically correct
 * (totalTurns() >= 5 gates correctly; work-tool guard stays session-scoped).
 *
 * This is a regression guard for the compaction-fragility fix: the v6
 * condition used `session.count() > 5` which resets to 0 on compaction;
 * v7 swaps that single term for `totalTurns() >= 5` (survives compaction).
 */
import { describe, it, expect } from "vitest";
import {
  validateCondition,
  smokeTestExpression,
  testExpression,
  type TestableSequence,
  createMockSequence,
} from "../../hook/condition-validator.js";

const V7_CONDITION =
  "call.args.confidence == 10 && !isPlanMode() && totalTurns() >= 5 && (session.count('edit_file') > 0 || session.count('write_file') > 0 || session.count('bash') > 0)";

/**
 * A TestableSequence whose totalTurns() returns a configurable value, backed
 * by a real MockSequence for the turn/session counting methods. Typed against
 * TestableSequence (the minimal interface) rather than MockSequence (which
 * carries private fields that `implements` cannot satisfy).
 */
class MockSeqWithTurns implements TestableSequence {
  private inner: ReturnType<typeof createMockSequence>;
  private turns: number;
  constructor(
    events: Array<{ tool: string; args: Record<string, unknown>; result: string }>,
    turns: number,
  ) {
    this.inner = createMockSequence(events);
    this.turns = turns;
  }
  turnCount(t?: string) { return this.inner.turnCount(t); }
  turnLastIndex(t: string) { return this.inner.turnLastIndex(t); }
  turnCountResult(t: string, p: string, m?: number) { return this.inner.turnCountResult(t, p, m); }
  turnHadError(t?: string) { return this.inner.turnHadError(t); }
  sessionCount(t?: string) { return this.inner.sessionCount(t); }
  sessionLastIndex(t: string) { return this.inner.sessionLastIndex(t); }
  sessionCountResult(t: string, p: string, m?: number) { return this.inner.sessionCountResult(t, p, m); }
  sessionHadError(t?: string) { return this.inner.sessionHadError(t); }
  isPlanMode() { return false; }
  totalTurns() { return this.turns; }
}

describe("learn-from-past v7 condition (totalTurns threshold)", () => {
  it("validates against the on-disk validator (totalTurns() allowed)", () => {
    const cond = {
      trigger: ["brief"],
      when: "v7",
      condition: V7_CONDITION,
      action: { type: "message" as const },
      version: 7,
      history: [],
    };
    const result = validateCondition(cond);
    expect(result.valid, result.errors.join("; ")).toBe(true);
  });

  it("passes the smoke test (evaluates without error on empty mock)", () => {
    const result = smokeTestExpression(V7_CONDITION);
    expect(result.passed, result.error || "smoke test failed").toBe(true);
  });

  it("fires when totalTurns()=6, confidence=10, and edit_file ran this session", () => {
    const seq = new MockSeqWithTurns([{ tool: "edit_file", args: { path: "a.ts" }, result: "ok" }], 6);
    const r = testExpression(V7_CONDITION, seq, { args: { confidence: 10 } });
    expect(r.passed).toBe(true);
    expect(r.evaluatedValue).toBe(true);
  });

  it("does NOT fire when totalTurns()=3 (below threshold) even with work tools", () => {
    const seq = new MockSeqWithTurns([{ tool: "edit_file", args: { path: "a.ts" }, result: "ok" }], 3);
    const r = testExpression(V7_CONDITION, seq, { args: { confidence: 10 } });
    expect(r.passed).toBe(true);
    expect(r.evaluatedValue).toBe(false);
  });

  it("does NOT fire when totalTurns()=6 but NO work tools ran (read-only session)", () => {
    const seq = new MockSeqWithTurns([{ tool: "read_file", args: { path: "a.ts" }, result: "ok" }], 6);
    const r = testExpression(V7_CONDITION, seq, { args: { confidence: 10 } });
    expect(r.evaluatedValue).toBe(false);
  });

  it("does NOT fire when confidence != 10", () => {
    const seq = new MockSeqWithTurns([{ tool: "edit_file", args: { path: "a.ts" }, result: "ok" }], 6);
    const r = testExpression(V7_CONDITION, seq, { args: { confidence: 8 } });
    expect(r.evaluatedValue).toBe(false);
  });

  it("boundary: fires at totalTurns()=5 exactly (>=5)", () => {
    const seq = new MockSeqWithTurns([{ tool: "bash", args: { command: "x" }, result: "ok" }], 5);
    const r = testExpression(V7_CONDITION, seq, { args: { confidence: 10 } });
    expect(r.evaluatedValue).toBe(true);
  });

  it("boundary: does NOT fire at totalTurns()=4", () => {
    const seq = new MockSeqWithTurns([{ tool: "bash", args: { command: "x" }, result: "ok" }], 4);
    const r = testExpression(V7_CONDITION, seq, { args: { confidence: 10 } });
    expect(r.evaluatedValue).toBe(false);
  });
});