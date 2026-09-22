/**
 * Tests for condition-validator schema validation functions
 */

import { describe, it, expect } from "vitest";
import { validateSchema, validateAction } from "../hook/condition-validator.js";
import type { Condition } from "../hook/conditions.js";

describe("validateSchema()", () => {
  describe("valid conditions", () => {
    it("should validate a minimal valid condition", () => {
      const condition: Condition = {
        trigger: ["bash"],
        when: "run lint before commit",
        condition: 'turn.count("edit_file") > 0',
        action: { type: "inject_before", tool: "bash", args: { command: "pnpm lint", intent: "TEST ARTIFACT TO verify lint" } },
        version: 1,
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate condition with wildcard trigger", () => {
      const condition: Condition = {
        trigger: ["*"],
        when: "any tool trigger",
        condition: "true",
        action: { type: "message" },
        version: 1,
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
    });

    it("should validate condition with history array", () => {
      const condition: Condition = {
        trigger: ["git_commit"],
        when: "block dangerous push",
        condition: 'turn.count("bash#git push") > 0',
        action: { type: "block", reason: "Dangerous push blocked" },
        version: 2,
        history: [{ version: 1, condition: 'session.count("bash#git push") > 0', action: { type: "block", reason: "Initial" } }],
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
    });

    it("should validate condition with session-level dedup", () => {
      const condition: Condition = {
        trigger: ["*"],
        when: "prevent duplicate skill injection",
        condition: "isPlanMode() && session.count('skill_load#plan-quality') == 0",
        action: { type: "message" },
        version: 1,
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
    });

    it("should validate condition with turn.hadError()", () => {
      const condition: Condition = {
        trigger: ["*"],
        when: "search wiki on error",
        condition: "turn.hadError() && turn.count('wiki_get') == 0",
        action: { type: "inject_before", tool: "wiki_get", args: { query: "error", domain: "pitfall" } },
        version: 1,
      };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid conditions", () => {
    it("should reject null condition", () => {
      const result = validateSchema(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Condition must be a non-null object");
    });



    it("should reject missing trigger", () => {
      const condition = { when: "test", condition: "true", action: { type: "message" }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("trigger"))).toBe(true);
    });





    it("should reject missing action", () => {
      const condition = { trigger: ["bash"], when: "test", condition: "true", version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(false);
    });

  });

  describe("warnings", () => {
    it("should accept any non-empty trigger (LLM decides validity)", () => {
      const condition: Condition = { trigger: ["unknown_tool_xyz"], when: "test", condition: "true", action: { type: "message" }, version: 1 };
      const result = validateSchema(condition);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should warn about empty trigger", () => {
      const condition: Condition = { trigger: [""], when: "test", condition: "true", action: { type: "message" }, version: 1 };
      const result = validateSchema(condition);
      expect(result.warnings.some(w => w.includes("trigger"))).toBe(true);
    });

    it("should warn about empty condition", () => {
      const condition: Condition = { trigger: ["bash"], when: "test", condition: "", action: { type: "message" }, version: 1 };
      const result = validateSchema(condition);
      expect(result.warnings.some(w => w.includes("condition"))).toBe(true);
    });
  });
});

describe("validateAction()", () => {
  it("should validate inject_before action", () => {
    const action = { type: "inject_before", tool: "bash", args: { command: "pnpm lint", intent: "TEST ARTIFACT TO verify lint" } };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });

  it("should reject inject_before without tool", () => {
    const action = { type: "inject_before", args: { command: "lint" } };
    const result = validateAction(action);
    expect(result.valid).toBe(false);
  });


  it("should warn about out-of-range timeout", () => {
    const action = { type: "inject_before", tool: "bash", args: { command: "lint", timeout: 500, intent: "TEST ARTIFACT TO verify behavior" } };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("timeout"))).toBe(true);
  });

  it("should validate block action", () => {
    const action = { type: "block", reason: "No dangerous action" };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });



  it("should validate message action", () => {
    const action = { type: "message" };
    const result = validateAction(action);
    expect(result.valid).toBe(true);
  });



});
