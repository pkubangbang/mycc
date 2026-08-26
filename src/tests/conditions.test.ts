/**
 * Tests for conditions.ts
 *
 * Tests cover:
 * - ConditionRegistry.load() with valid/invalid JSON
 * - ConditionRegistry.matches() with various triggers
 * - ConditionRegistry.get/set/findByTrigger
 * - Atomic file writes and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConditionRegistry, type Condition, type HookAction } from "../hook/conditions.js";
import { Sequence } from "../hook/sequence.js";
import * as fs from "fs";
import * as path from "path";

// Mock getMyccDir to use temp directory within project
const testDir = path.join(process.cwd(), ".tmp-test-conditions");
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    getMyccDir: () => testDir,
  };
});

// ============================================================================
// ConditionRegistry Core Tests
// ============================================================================

describe("ConditionRegistry", () => {
  let registry: ConditionRegistry;
  const conditionsFile = path.join(testDir, "conditions.json");

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    registry = new ConditionRegistry();
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  // ============================================================================
  // load()
  // ============================================================================

  describe("load()", () => {
    it("should handle missing file gracefully", async () => {
      // No file exists
      await registry.load();
      expect(registry.get("any-skill")).toBeUndefined();
    });

    it("should load valid conditions.json", async () => {
      const conditions: Record<string, Condition> = {
        "pre-commit-lint": {
          trigger: ["git_commit"],
          when: "run lint before commit",
          condition: 'turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm lint") == -1',
          action: {
            type: "inject_before",
            tool: "bash",
            args: { command: "pnpm lint", intent: "TEST ARTIFACT TO verify lint before commit" },
          },
          version: 1,
        },
        "block-dangerous-push": {
          trigger: ["bash"],
          when: "block dangerous push to main",
          condition: 'turn.count("bash#git push --force") > 0',
          action: { type: "block", reason: "Dangerous push to main is prohibited" },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      expect(registry.get("pre-commit-lint")).toBeDefined();
      expect(registry.get("block-dangerous-push")).toBeDefined();
    });

    it("should handle invalid JSON gracefully", async () => {
      fs.writeFileSync(conditionsFile, "{ invalid json }");

      // Should not throw, just log error
      await registry.load();
      expect(registry.get("any-skill")).toBeUndefined();
    });

    it("should handle malformed JSON with partial content", async () => {
      fs.writeFileSync(conditionsFile, '{"skill1": { "trigger": "bash"'); // Incomplete

      await registry.load();
      expect(registry.get("skill1")).toBeUndefined();
    });

    it("should validate and fix empty trigger", async () => {
      const conditions: Record<string, Condition> = {
        "test-skill": {
          trigger: [""], // Empty trigger - produces warning but is valid
          when: "test",
          condition: "true",
          action: { type: "message" },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      // Empty trigger passes validation (warning only), load may reject if validation fails
      // The condition is loaded since validation passes
      const cond = registry.get("test-skill");
      // Empty trigger produces a warning about empty string
      expect(cond?.trigger).toEqual([""]);
    });

    it("should clamp invalid timeout values", async () => {
      const conditions: Record<string, Condition> = {
        "test-skill": {
          trigger: ["bash"],
          when: "test",
          condition: "true",
          action: {
            type: "inject_before",
            tool: "bash",
            args: { command: "test", timeout: 100, intent: "TEST ARTIFACT TO verify timeout clamping" }, // Out of range
          },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      const cond = registry.get("test-skill");
      const args = cond?.action as { args: { timeout?: number } };
      // Timeout is clamped to 1-60 range in applyRuntimeFixes
      expect(args.args.timeout).toBeLessThanOrEqual(60);
    });

    it("should fix timeout in history entries too", async () => {
      const conditions: Record<string, Condition> = {
        "test-skill": {
          trigger: ["bash"],
          when: "test",
          condition: "true",
          action: {
            type: "inject_before",
            tool: "bash",
            args: { command: "test", intent: "TEST ARTIFACT TO verify timeout fix" },
          },
          version: 2,
          history: [
            {
              version: 1,
              condition: "true",
              action: {
                type: "inject_before",
                tool: "bash",
                args: { command: "test", timeout: 0 }, // Invalid
              },
            },
          ],
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      await registry.load();

      const cond = registry.get("test-skill");
      const historyEntry = cond?.history?.[0];
      const args = historyEntry?.action as { args: { timeout?: number } };
      expect(args.args.timeout).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // save()
  // ============================================================================

  describe("save()", () => {
    it("should save conditions to file", async () => {
      registry.set("test-skill", {
        trigger: ["bash"],
        when: "test",
        condition: "true",
        action: { type: "message" },
        version: 1,
      });

      await registry.save();

      expect(fs.existsSync(conditionsFile)).toBe(true);
      const content = fs.readFileSync(conditionsFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed["test-skill"]).toBeDefined();
    });

    it("should create directory if missing", async () => {
      // Remove directory
      fs.rmSync(testDir, { recursive: true, force: true });

      registry.set("test-skill", {
        trigger: ["bash"],
        when: "test",
        condition: "true",
        action: { type: "message" },
        version: 1,
      });

      await registry.save();

      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(conditionsFile)).toBe(true);
    });

    it("should preserve all condition fields", async () => {
      const fullCondition: Condition = {
        trigger: ["git_commit"],
        when: "run lint before commit",
        condition: 'turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm lint") == -1',
        action: {
          type: "inject_before",
          tool: "bash",
          args: { command: "pnpm lint", intent: "TEST ARTIFACT TO verify lint", timeout: 60 },
        },
        version: 2,
        history: [
          {
            version: 1,
            condition: 'turn.count("edit_file") > 0',
            action: { type: "message" },
            reason: "initial compilation",
          },
        ],
      };

      registry.set("pre-commit-lint", fullCondition);

      await registry.save();

      const content = fs.readFileSync(conditionsFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed["pre-commit-lint"]).toEqual(fullCondition);
    });

    it("should handle multiple conditions", async () => {
      registry.set("skill1", {
        trigger: ["bash"],
        when: "test1",
        condition: "true",
        action: { type: "message" },
        version: 1,
      });
      registry.set("skill2", {
        trigger: ["git_commit"],
        when: "test2",
        condition: "false",
        action: { type: "block" },
        version: 1,
      });

      await registry.save();

      const content = fs.readFileSync(conditionsFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(Object.keys(parsed)).toHaveLength(2);
    });
  });

  // get() / set()
  describe("get() / set()", () => {
    it("should get undefined for non-existent skill", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("should set and get condition", () => {
      const condition: Condition = {
        trigger: ["bash"],
        when: "test",
        condition: "true",
        action: { type: "message" },
        version: 1,
      };
      registry.set("test-skill", condition);
      expect(registry.get("test-skill")).toEqual(condition);
    });

    it("should overwrite existing condition", () => {
      registry.set("test-skill", {
        trigger: ["bash"],
        when: "test",
        condition: "true",
        action: { type: "message" },
        version: 1,
      });
      registry.set("test-skill", {
        trigger: ["git_commit"],
        when: "updated",
        condition: "false",
        action: { type: "block" },
        version: 2,
      });
      const cond = registry.get("test-skill");
      expect(cond?.trigger).toEqual(["git_commit"]);
      expect(cond?.version).toBe(2);
    });
  });

  // findByTrigger()
  describe("findByTrigger()", () => {
    beforeEach(() => {
      registry.set("any-hook", {
        trigger: ["*"], when: "any tool", condition: "true",
        action: { type: "message" }, version: 1,
      });
      registry.set("bash-hook", {
        trigger: ["bash"], when: "bash only", condition: "true",
        action: { type: "message" }, version: 1,
      });
      registry.set("commit-hook", {
        trigger: ["git_commit"], when: "commit only", condition: "true",
        action: { type: "message" }, version: 1,
      });
    });

    it("should find conditions with exact trigger", () => {
      const bashHooks = registry.findByTrigger("bash");
      expect(bashHooks).toHaveLength(2);
      expect(bashHooks.some(h => h.when === "bash only")).toBe(true);
    });

    it("should find wildcard conditions for any trigger", () => {
      const editHooks = registry.findByTrigger("edit_file");
      expect(editHooks).toHaveLength(1);
      expect(editHooks[0].trigger).toEqual(["*"]);
    });

    it("should return empty array for no matches", () => {
      registry = new ConditionRegistry();
      expect(registry.findByTrigger("bash")).toHaveLength(0);
    });
  });

  // matches()
  describe("matches()", () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = new Sequence();

      registry.set("edit-reminder", {
        trigger: ["edit_file"],
        when: "remind about tests after edit",
        condition: 'turn.count("edit_file") >= 2',
        action: { type: "message" },
        version: 1,
      });

      registry.set("any-error", {
        trigger: ["*"],
        when: "search wiki on error",
        condition: "turn.hadError()",
        action: { type: "inject_before", tool: "wiki_get", args: { query: "error", domain: "pitfall" } },
        version: 1,
      });
    });

    it("should match condition that evaluates to true", () => {
      seq.add({ tool: "edit_file", args: { path: "a.ts" }, result: "ok", timestamp: 1000 });
      seq.add({ tool: "edit_file", args: { path: "b.ts" }, result: "ok", timestamp: 2000 });
      const matches = registry.matches("edit_file", seq);
      expect(matches).toContain("edit-reminder");
    });

    it("should not match condition that evaluates to false", () => {
      seq.add({ tool: "edit_file", args: { path: "a.ts" }, result: "ok", timestamp: 1000 });
      const matches = registry.matches("edit_file", seq);
      expect(matches).not.toContain("edit-reminder");
    });

    it("should match wildcard trigger for any tool", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "Error: failed", timestamp: 1000 });
      const matches = registry.matches("bash", seq);
      expect(matches).toContain("any-error");
    });

    it("should not match different trigger", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "ok", timestamp: 1000 });
      const matches = registry.matches("bash", seq);
      expect(matches).not.toContain("edit-reminder");
    });

    it("should match even when previously injected", () => {
      seq.add({ tool: "bash", args: { command: "test" }, result: "Error: failed", timestamp: 1000 });
      const matches1 = registry.matches("bash", seq);
      expect(matches1).toContain("any-error");
      registry.markInjected("any-error");
      const matches2 = registry.matches("bash", seq);
      expect(matches2).toContain("any-error");
    });

    it("should return multiple matching conditions", () => {
      registry.set("another-bash-hook", {
        trigger: ["bash"], when: "another hook",
        condition: "turn.count() > 0",
        action: { type: "message" }, version: 1,
      });
      seq.add({ tool: "bash", args: { command: "test" }, result: "Error: failed", timestamp: 1000 });
      const matches = registry.matches("bash", seq);
      expect(matches).toContain("any-error");
      expect(matches).toContain("another-bash-hook");
    });
  });

  // pending management
  describe("pending management", () => {
    it("should mark skill as pending", () => {
      registry.markPending("new-skill");
      expect(registry.needsCompilation("new-skill")).toBe(true);
    });

    it("should not mark skill with existing condition as pending", () => {
      registry.set("existing-skill", {
        trigger: ["bash"], when: "test", condition: "true",
        action: { type: "message" }, version: 1,
      });
      registry.markPending("existing-skill");
      expect(registry.needsCompilation("existing-skill")).toBe(false);
    });

    it("should remove from pending when condition is set", () => {
      registry.markPending("new-skill");
      expect(registry.needsCompilation("new-skill")).toBe(true);
      registry.set("new-skill", {
        trigger: ["bash"], when: "test", condition: "true",
        action: { type: "message" }, version: 1,
      });
      expect(registry.needsCompilation("new-skill")).toBe(false);
    });
  });

  // injected management
  describe("injected management", () => {
    it("should track injected skills", () => {
      expect(registry.hasInjected("test-skill")).toBe(false);
      registry.markInjected("test-skill");
      expect(registry.hasInjected("test-skill")).toBe(true);
    });

    it("should clear all injected markers", () => {
      registry.markInjected("skill1");
      registry.markInjected("skill2");
      expect(registry.hasInjected("skill1")).toBe(true);
      expect(registry.hasInjected("skill2")).toBe(true);
      registry.clearInjected();
      expect(registry.hasInjected("skill1")).toBe(false);
      expect(registry.hasInjected("skill2")).toBe(false);
    });
  });

  // load/save roundtrip
  describe("load/save roundtrip", () => {
    it("should preserve conditions through save/load cycle", async () => {
      const original: Condition = {
        trigger: ["git_commit"],
        when: "run tests before commit",
        condition: 'turn.count("edit_file") > 0 && turn.lastIndex("bash#pnpm test") == -1',
        action: {
          type: "inject_before", tool: "bash",
          args: { command: "pnpm test", intent: "TEST ARTIFACT TO verify behavior before commit", timeout: 30 },
        },
        version: 2,
        history: [{
          version: 1, condition: 'turn.count("edit_file") > 0',
          action: { type: "inject_before", tool: "bash", args: { command: "pnpm test" } },
          reason: "initial",
        }],
      };
      registry.set("pre-commit-test", original);
      await registry.save();
      const newRegistry = new ConditionRegistry();
      await newRegistry.load();
      const loaded = newRegistry.get("pre-commit-test");
      expect(loaded).toEqual(original);
    });

    it("should handle special characters in condition", async () => {
      const condition: Condition = {
        trigger: ["bash"], when: "test special chars",
        condition: 'turn.count("bash#git push --force") > 0',
        action: { type: "block", reason: "Dangerous push blocked!" },
        version: 1,
      };
      registry.set("special-chars", condition);
      await registry.save();
      const newRegistry = new ConditionRegistry();
      await newRegistry.load();
      const loaded = newRegistry.get("special-chars");
      expect(loaded?.condition).toBe('turn.count("bash#git push --force") > 0');
    });

    it("should handle empty conditions file", async () => {
      fs.writeFileSync(conditionsFile, "{}");
      await registry.load();
      expect(registry.get("any")).toBeUndefined();
    });
  });

  // edge cases
  describe("edge cases", () => {
    it("should handle null values in JSON", async () => {
      fs.writeFileSync(conditionsFile, '{"skill1": null}');
      await registry.load();
      expect(registry.get("skill1")).toBeUndefined();
    });

    it("should collect legacy seq.X conditions in legacyConditions", async () => {
      // A condition written against the old `seq.X` API fails validation
      // (the validator explicitly rejects `seq.` syntax). load() should:
      //   1. NOT load the condition (it stays inactive)
      //   2. Collect it into legacyConditions so the agent can be prompted
      //      to recompile via skill_compile.
      const conditions = {
        "legacy-hook": {
          trigger: ["git_commit"],
          when: "run lint before commit",
          condition: 'seq.lastIndexOf("bash#pnpm lint") == -1',
          action: { type: "block", reason: "Run lint first" },
          version: 1,
          sourceFile: "project:legacy-hook",
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      const result = await registry.load();

      // Condition is NOT loaded (rejected at validation)
      expect(registry.get("legacy-hook")).toBeUndefined();
      // It IS collected as a legacy condition for recompile prompting
      expect(result.legacyConditions).toHaveLength(1);
      expect(result.legacyConditions[0]).toMatchObject({
        name: "legacy-hook",
        when: "run lint before commit",
        condition: 'seq.lastIndexOf("bash#pnpm lint") == -1',
        sourceFile: "project:legacy-hook",
      });
      // An error is still reported (validation failure message)
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should NOT collect valid turn.X conditions as legacy", async () => {
      const conditions = {
        "valid-hook": {
          trigger: ["git_commit"],
          when: "run lint before commit",
          condition: 'turn.lastIndex("bash#pnpm lint") == -1',
          action: { type: "block", reason: "Run lint first" },
          version: 1,
        },
      };

      fs.writeFileSync(conditionsFile, JSON.stringify(conditions, null, 2));
      const result = await registry.load();

      expect(registry.get("valid-hook")).toBeDefined();
      expect(result.legacyConditions).toHaveLength(0);
    });

    it("should handle array instead of object", async () => {
      fs.writeFileSync(conditionsFile, "[]");
      await registry.load();
    });

    it("should handle file write failure gracefully", async () => {
      fs.rmSync(testDir, { recursive: true, force: true });
      fs.writeFileSync(testDir, "not a directory");
      registry.set("test", {
        trigger: ["bash"], when: "test", condition: "true",
        action: { type: "message" }, version: 1,
      });
      await registry.save();
      fs.rmSync(testDir, { force: true });
    });
  });
});

// Type Tests
describe("HookAction Types", () => {
  it("should accept inject_before action", () => {
    const action: HookAction = { type: "inject_before", tool: "bash", args: { command: "test" } };
    expect(action.type).toBe("inject_before");
  });

  it("should accept inject_after action", () => {
    const action: HookAction = { type: "inject_after", tool: "wiki_get", args: { query: "test", domain: "project" } };
    expect(action.type).toBe("inject_after");
  });

  it("should accept block action", () => {
    const action: HookAction = { type: "block", reason: "Not allowed" };
    expect(action.type).toBe("block");
  });

  it("should accept replace action", () => {
    const action: HookAction = { type: "replace", tool: "bash", args: { command: "safe-command" } };
    expect(action.type).toBe("replace");
  });

  it("should accept message action", () => {
    const action: HookAction = { type: "message" };
    expect(action.type).toBe("message");
  });

  it("should support optional timeout in inject actions", () => {
    const action: HookAction = { type: "inject_before", tool: "bash", args: { command: "test", timeout: 60 } };
    expect((action as { args: { timeout?: number } }).args.timeout).toBe(60);
  });
});
