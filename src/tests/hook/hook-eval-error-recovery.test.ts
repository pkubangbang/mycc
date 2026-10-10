/**
 * hook-eval-error-recovery.test.ts - Self-healing path for runtime hook
 * conditions that THROW during evaluation.
 *
 * Regression coverage for the peer incident: a `release-windows-cpu-build`
 * condition led with `call.args.command.includes('gh release')`, which throws
 * "Cannot call method on undefined" when the current call has no `command`
 * arg. The evaluator caught it, logged a SCARY stack trace, and returned false
 * — silently disabling the whole hook (including its turn.countResult
 * fallbacks), with NOTHING telling the agent to fix it.
 *
 * This suite pins the fix:
 *   1. A throwing condition is reported via the onEvalError observer (not
 *      silently swallowed).
 *   2. `ConditionRegistry.matches()` attributes the failure to the hook's
 *      skill name, so it can be surfaced for recompilation.
 *   3. The condition is NOT matched (fail-safe: a broken hook does not fire).
 *   4. A recompiled, guarded condition evaluates cleanly and the failure record
 *      is cleared.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Sequence } from "../../hook/sequence.js";
import { ConditionRegistry } from "../../hook/conditions.js";
import { evaluateExpression, type EvalContext } from "../../hook/evaluator.js";
import { buildHookInfoMessages } from "../../loop/hook-bootstrap.js";

// The peer's original (unguarded) condition.
const UNGUARDED =
  `call.args.command.includes('gh release') ` +
  `|| (turn.countResult('bash', 'HTTP 404', 500) > 0 && turn.countResult('bash', 'ollama/ollama', 500) > 0) ` +
  `|| turn.countResult('bash', 'timeout', 500) > 0`;

// The corrected (guarded) condition — value checks first, guarded access last.
const GUARDED =
  `turn.countResult('bash', 'HTTP 404', 500) > 0 && turn.countResult('bash', 'ollama/ollama', 500) > 0 ` +
  `|| turn.countResult('bash', 'timeout', 500) > 0 ` +
  `|| (call.args.command != undefined && call.args.command.includes('gh release'))`;

/** Minimal EvalContext backed by a real Sequence. */
function ctxFor(seq: Sequence, onEvalError?: (e: Error) => void): EvalContext {
  return {
    turnCount: (t?: string) => seq.turnCount(t),
    turnLastIndex: (t: string) => seq.turnLastIndex(t),
    turnCountResult: (t: string, p: string, m?: number) => seq.turnCountResult(t, p, m),
    turnHadError: (t?: string) => seq.turnHadError(t),
    sessionCount: (t?: string) => seq.sessionCount(t),
    sessionLastIndex: (t: string) => seq.sessionLastIndex(t),
    sessionCountResult: (t: string, p: string, m?: number) => seq.sessionCountResult(t, p, m),
    sessionHadError: (t?: string) => seq.sessionHadError(t),
    isPlanMode: () => seq.isPlanMode(),
    totalTurns: () => seq.getTotalTurns(),
    onEvalError,
  };
}

describe("evaluator onEvalError observer", () => {
  it("invokes the observer when a condition throws (unguarded call.args access)", () => {
    const seq = new Sequence();
    const errors: Error[] = [];
    const ok = evaluateExpression(
      UNGUARDED,
      { ...ctxFor(seq, (e) => errors.push(e)), call: { args: {} } },
    );
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Cannot call method on undefined");
  });

  it("does NOT invoke the observer on a clean evaluation", () => {
    const seq = new Sequence();
    const errors: Error[] = [];
    const ok = evaluateExpression(
      "turn.count('bash') > 0",
      { ...ctxFor(seq, (e) => errors.push(e)), call: { args: {} } },
    );
    expect(ok).toBe(false); // no bash events
    expect(errors).toHaveLength(0);
  });

  it("a throwing observer never crashes the evaluator (still returns false)", () => {
    const seq = new Sequence();
    const ok = evaluateExpression(
      UNGUARDED,
      { ...ctxFor(seq, () => { throw new Error("observer boom"); }), call: { args: {} } },
    );
    expect(ok).toBe(false);
  });

  it("attaches the failing sub-expression to the error (tells WHERE it died)", () => {
    const seq = new Sequence();
    const errors: Error[] = [];
    evaluateExpression(
      UNGUARDED,
      { ...ctxFor(seq, (e) => errors.push(e)), call: { args: {} } },
    );
    expect(errors).toHaveLength(1);
    const withNode = errors[0] as Error & { nodeText?: string };
    // The node that actually threw is the `.includes(...)` CallExpression, so
    // the message names the exact failing call rather than the whole condition.
    expect(withNode.nodeText).toContain("call.args.command.includes");
  });

  it("reports the failing node in the always-on hook brief (not verbose-only)", () => {
    const seq = new Sequence();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      evaluateExpression(UNGUARDED, { ...ctxFor(seq), call: { args: {} } });
      const captured = [...warnSpy.mock.calls, ...logSpy.mock.calls]
        .map((c) => c.map((x) => String(x)).join(" "))
        .join("\n");
      expect(captured).toContain("hook");
      expect(captured).toContain("call.args.command");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("ConditionRegistry.matches() self-healing", () => {
  /** Register a condition directly and return the registry. */
  function registryWith(name: string, condition: string): ConditionRegistry {
    const reg = new ConditionRegistry();
    reg.set(name, {
      trigger: ["bash"],
      when: "when asked to publish a GitHub release",
      condition,
      action: { type: "message", message: "x" },
      version: 1,
    });
    return reg;
  }

  it("attributes a throwing condition to the hook and reports it", () => {
    const reg = registryWith("release-windows-cpu-build", UNGUARDED);
    const seq = new Sequence();

    // Evaluate against a call WITHOUT args.command (non-bash / bare call).
    const matched = reg.matches("bash", seq, { args: {} });

    // Fail-safe: the broken hook does NOT match (never fires).
    expect(matched).not.toContain("release-windows-cpu-build");

    // …but the failure IS recorded, keyed by skill name, with the condition.
    const errored = reg.getErroredConditions();
    expect(errored).toHaveLength(1);
    expect(errored[0].name).toBe("release-windows-cpu-build");
    expect(errored[0].condition).toBe(UNGUARDED);
    expect(errored[0].when).toContain("publish a GitHub release");
    expect(errored[0].error).toContain("Cannot call method on undefined");
  });

  it("does NOT record a failure for a healthy condition", () => {
    const reg = registryWith("healthy", "turn.count('bash') > 0 || call.args.command == undefined");
    const seq = new Sequence();
    reg.matches("bash", seq, { args: { command: "ls" } });
    expect(reg.getErroredConditions()).toHaveLength(0);
  });

  it("keeps only the FIRST error per hook (no unbounded growth across calls)", () => {
    const reg = registryWith("release-windows-cpu-build", UNGUARDED);
    const seq = new Sequence();
    reg.matches("bash", seq, { args: {} });
    reg.matches("bash", seq, { args: {} });
    reg.matches("bash", seq, { args: {} });
    expect(reg.getErroredConditions()).toHaveLength(1);
  });

  it("clears the failure record once the hook is recompiled to a guarded form", () => {
    const reg = registryWith("release-windows-cpu-build", UNGUARDED);
    const seq = new Sequence();

    reg.matches("bash", seq, { args: {} });
    expect(reg.getErroredConditions()).toHaveLength(1);

    // Simulate a recompile producing the guarded condition.
    reg.set("release-windows-cpu-build", {
      trigger: ["bash"],
      when: "when asked to publish a GitHub release",
      condition: GUARDED,
      action: { type: "message", message: "x" },
      version: 2,
    });
    reg.clearEvalFailure("release-windows-cpu-build");

    // Now a bare call no longer throws; the record stays clear.
    reg.matches("bash", seq, { args: {} });
    expect(reg.getErroredConditions()).toHaveLength(0);
  });

  it("guarded condition fires true when the command matches (no crash on bare call)", () => {
    const reg = registryWith("release-windows-cpu-build", GUARDED);
    const seq = new Sequence();

    // Bare call (no args.command) → no crash, no match.
    expect(reg.matches("bash", seq, { args: {} })).not.toContain("release-windows-cpu-build");
    expect(reg.getErroredConditions()).toHaveLength(0);

    // Matching command → fires.
    const matched = reg.matches("bash", seq, { args: { command: "gh release create v1" } });
    expect(matched).toContain("release-windows-cpu-build");
  });
});

// ---------------------------------------------------------------------------
// Runtime notice: the failure is surfaced the moment it first occurs, not
// only at the next project-context rebuild.
// ---------------------------------------------------------------------------

describe("runtime eval-failure notice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a friendly one-shot notice naming the hook and the skill_compile fix", () => {
    const reg = new ConditionRegistry();
    reg.set("release-windows-cpu-build", {
      trigger: ["bash"],
      when: "when asked to publish a GitHub release",
      condition: UNGUARDED,
      action: { type: "message", message: "x" },
      version: 1,
    });

    // agentIO.brief routes through console.warn when no output callback is set.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    reg.matches("bash", new Sequence(), { args: {} });

    const captured = [...warnSpy.mock.calls, ...logSpy.mock.calls]
      .map((c) => String(c[0]))
      .join("\n");

    // The notice names the hook, says it is inactive, and tells the agent how
    // to fix it — WITHOUT a scary stack trace.
    expect(captured).toContain("release-windows-cpu-build");
    expect(captured).toContain("inactive");
    expect(captured).toContain("skill_compile");
    expect(captured).toContain("could not be checked and was skipped");
    expect(captured).not.toContain("at evaluateNode");

    // A second failed evaluation must NOT re-spam the notice (one-shot).
    warnSpy.mockClear();
    logSpy.mockClear();
    reg.matches("bash", new Sequence(), { args: {} });
    const second = [...warnSpy.mock.calls, ...logSpy.mock.calls]
      .map((c) => String(c[0]))
      .join("\n");
    expect(second).not.toContain("release-windows-cpu-build");
  });
});

// ---------------------------------------------------------------------------
// projectContext surfacing: buildHookInfoMessages renders the [Hooks Erroring]
// block (the durable, rebuild-time surface) with a recompile instruction.
// ---------------------------------------------------------------------------

describe("buildHookInfoMessages [Hooks Erroring]", () => {
  it("renders an erroring hooks block with the failing condition and recompile hint", () => {
    const reg = new ConditionRegistry();
    reg.set("release-windows-cpu-build", {
      trigger: ["bash"],
      when: "when asked to publish a GitHub release",
      condition: UNGUARDED,
      action: { type: "message", message: "x" },
      version: 1,
    });
    reg.matches("bash", new Sequence(), { args: {} });

    // Minimal loader stub (unused for the erroring block, but required).
    const loader = {
      getSkill: () => undefined,
      listSkills: () => [],
      setConditionRegistry: () => {},
    };

    const messages = buildHookInfoMessages(reg, loader);
    const text = messages.map((m) => m.content).join("\n");

    expect(text).toContain("[Hooks Erroring]");
    expect(text).toContain("release-windows-cpu-build");
    expect(text).toContain("skill_compile(name=\"release-windows-cpu-build\")");
    expect(text).toContain("Cannot call method on undefined");
    expect(text).toContain("call.args.command != undefined");
  });

  it("omits the block when no condition has errored", () => {
    const reg = new ConditionRegistry();
    const loader = {
      getSkill: () => undefined,
      listSkills: () => [],
      setConditionRegistry: () => {},
    };
    const messages = buildHookInfoMessages(reg, loader);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("[Hooks Erroring]");
  });
});
