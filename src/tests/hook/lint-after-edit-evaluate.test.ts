/**
 * lint-after-edit-evaluate.test.ts - Unit test for evaluate() against
 * the lint-after-edit skill condition.
 *
 * This test harness reproduces the exact scenario from session
 * lead-1779115527-triologue.jsonl (embedded below) and verifies that
 * evaluate() properly interprets the condition expression.
 *
 * The condition is:
 *   (seq.totalCount('edit_file') > 0 || seq.totalCount('write_file') > 0)
 *   && (seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint')
 *       || seq.lastIndexOf('write_file') >= seq.lastIndexOf('bash#pnpm lint')
 *       || seq.lastIndexOf('bash#pnpm lint') == -1)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Sequence, type SequenceEvent } from '../../hook/sequence.js';
import { Triologue } from '../../loop/triologue.js';

// ============================================================================
// Embedded session transcript (from lead-1779115527-triologue.jsonl)
// ============================================================================

interface JsonlMessage {
  role: string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  args?: Record<string, unknown>;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

const SESSION_TRANSCRIPT_RAW: JsonlMessage[] = [
  { "role": "user", "content": "add \"action type\" to the skill_compile's log output." },
  { "role": "assistant", "content": "I'll help you add \"action type\" to the skill_compile's log output.", "tool_calls": [{ "id": "call_iza7gvcm", "function": { "name": "recall", "arguments": { "path": "/" } } }] },
  { "role": "tool", "tool_name": "recall", "content": "# CLAUDE\nPath: /\nLevel: 0\n\n## Summary\nThe **CLAUDE** section covers the project's CLAUDE.md file and mindmap memory system...", "tool_call_id": "call_iza7gvcm" },
  { "role": "assistant", "content": "Let me explore more to find the skill_compile tool:", "tool_calls": [{ "id": "call_zkch77d2", "function": { "name": "recall", "arguments": { "path": "/skill" } } }] },
  { "role": "tool", "tool_name": "recall", "content": "Node not found: /skill", "tool_call_id": "call_zkch77d2" },
  { "role": "assistant", "content": "Let me look at the actual skill_compile implementation:", "tool_calls": [{ "id": "call_a1", "function": { "name": "bash", "arguments": { "command": "grep -rn 'skill_compile' src/" } } }] },
  { "role": "tool", "tool_name": "bash", "content": "src/slashes/skill-compile.ts: line 45", "tool_call_id": "call_a1" },
  { "role": "assistant", "content": "Let me read the file:", "tool_calls": [{ "id": "call_a2", "function": { "name": "bash", "arguments": { "command": "cat src/slashes/skill-compile.ts" } } }] },
  { "role": "tool", "tool_name": "bash", "content": "export async function skillCompile() {}", "tool_call_id": "call_a2" },
  { "role": "user", "content": "[REMINDER] Use brief tool to report key progress or findings to the user." },
  { "role": "user", "content": "[HINT] Problem Analysis: ..." },
  { "role": "assistant", "content": "I'll look at the skill_compile source:", "tool_calls": [{ "id": "call_b1", "function": { "name": "read_file", "arguments": { "path": "src/slashes/skill-compile.ts" } } }] },
  { "role": "tool", "tool_name": "read_file", "content": "export async function skillCompile(ctx, when, name, content)", "tool_call_id": "call_b1" },
  { "role": "assistant", "content": "I see the code. I'll add the action type to the log output.", "tool_calls": [{ "id": "call_b2", "function": { "name": "brief", "arguments": { "message": "Found code, planning edit", "confidence": 7 } } }] },
  { "role": "tool", "tool_name": "brief", "content": "OK", "tool_call_id": "call_b2" },
  { "role": "assistant", "content": "Now let me make the edit:", "tool_calls": [{ "id": "call_c1", "function": { "name": "read_file", "arguments": { "path": "src/slashes/skill-compile.ts" } } }] },
  { "role": "tool", "tool_name": "read_file", "content": "export async function skillCompile(ctx, when, name, content)", "tool_call_id": "call_c1" },
  { "role": "assistant", "content": "Let me check the exact line:", "tool_calls": [{ "id": "call_c2", "function": { "name": "bash", "arguments": { "command": "grep -n 'action' src/slashes/skill-compile.ts" } } }] },
  { "role": "tool", "tool_name": "bash", "content": "45:  console.log('action:', action.type)", "tool_call_id": "call_c2" },
  { "role": "user", "content": "[REMINDER] Update your todos." },
  { "role": "assistant", "content": "Let me make the edit now:", "tool_calls": [{ "id": "call_d1", "function": { "name": "bash", "arguments": { "command": "sed -i 's/...' src/slashes/skill-compile.ts" } } }] },
  { "role": "tool", "tool_name": "bash", "content": "OK", "tool_call_id": "call_d1" },
  { "role": "assistant", "content": "Now I'll edit the file to add action type logging:", "tool_calls": [{ "id": "call_d2", "function": { "name": "edit_file", "arguments": { "path": "src/slashes/skill-compile.ts", "old_text": "log", "new_text": "log with action type" } } }] },
  { "role": "tool", "tool_name": "edit_file", "content": "OK", "tool_call_id": "call_d2" },
  { "role": "user", "content": "[REMINDER] Provide a brief status update using the brief tool." },
  { "role": "assistant", "content": "Changes applied.", "tool_calls": [{ "id": "call_e1", "function": { "name": "brief", "arguments": { "message": "Added action type to skill_compile log output", "confidence": 10 } } }] },
  { "role": "tool", "tool_name": "brief", "content": "OK", "tool_call_id": "call_e1" },
];

/**
 * Extract tool events from the embedded transcript
 */
function extractEvents(): SequenceEvent[] {
  const events: SequenceEvent[] = [];
  for (const msg of SESSION_TRANSCRIPT_RAW) {
    if (msg.role === 'tool') {
      events.push({
        tool: msg.tool_name || 'unknown',
        args: msg.args || {},
        result: msg.content || '',
        timestamp: Date.now(),
      });
    }
  }
  return events;
}

/**
 * Build a Triologue from the embedded transcript by injecting messages
 * directly into the internal messages array (bypassing microCompact).
 * This is the same approach as reading from the JSONL file — we use the
 * private addMessage via TypeScript's `as any` escape hatch, which was how
 * the original file-based test worked.
 */
function buildTriologue(): Triologue {
  const t = new Triologue();
  for (const msg of SESSION_TRANSCRIPT_RAW) {
    // tslint:disable-next-line:no-any — accessing private addMessage to bypass microCompact
    (t as any).addMessage(msg as any);
  }
  return t;
}

// ============================================================================
// Session events (extracted once)
// ============================================================================

const sessionEvents = extractEvents();

// ============================================================================
// The lint-after-edit condition (from .mycc/conditions.json, version 7)
// ============================================================================

const LINT_AFTER_EDIT_CONDITION =
  `(seq.totalCount('edit_file') > 0 || seq.totalCount('write_file') > 0) ` +
  `&& (seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') ` +
  `    || seq.lastIndexOf('write_file') >= seq.lastIndexOf('bash#pnpm lint') ` +
  `    || seq.lastIndexOf('bash#pnpm lint') == -1)`;

// ============================================================================
// Test Cases
// ============================================================================

describe('evaluate() with lint-after-edit condition', () => {
  // ==========================================================================
  // No Triologue (the bug scenario)
  // ==========================================================================
  describe('without Triologue (the bug scenario)', () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = new Sequence();
      for (const event of sessionEvents) {
        seq.add(event);
      }
    });

    it('should have all 11 events from the session', () => {
      expect(seq.getEvents()).toHaveLength(11);
    });

    it('should have edit_file event in sequence', () => {
      expect(seq.has('edit_file')).toBe(true);
    });

    it('should have bash events in sequence', () => {
      expect(seq.has('bash')).toBe(true);
    });

    it('seq.totalCount("edit_file") returns correct count without Triologue using tally table', () => {
      const count = seq.totalCount('edit_file');
      expect(count).toBe(1);
    });

    it('totalCount for specific tools returns correct counts from tally table', () => {
      expect(seq.totalCount('bash')).toBe(4);
      expect(seq.totalCount('write_file')).toBe(0);
      expect(seq.totalCount('recall')).toBe(2);
      expect(seq.totalCount('read_file')).toBe(2);
      expect(seq.totalCount('brief')).toBe(2);
    });

    it('totalCount() without args returns correct session total', () => {
      expect(seq.totalCount()).toBe(11);
    });

    it('evaluate() returns true due to fixed totalCount', () => {
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it('other seq functions work correctly without Triologue', () => {
      // Verify that the other functions used in the condition are fine
      expect(seq.has('edit_file')).toBe(true);
      expect(seq.has('write_file')).toBe(false);

      // lastIndexOf for edit_file should be the index of the edit_file event
      const editIdx = seq.lastIndexOf('edit_file');
      expect(editIdx).not.toBe(-1);
      expect(editIdx).toBeGreaterThanOrEqual(0);

      // lastIndexOf for bash#pnpm lint should be -1 (no lint was run)
      const lintIdx = seq.lastIndexOf('bash#pnpm lint');
      expect(lintIdx).toBe(-1);

      // The ordering check: edit after lint? Since lint was never run,
      // lastIndexOf('bash#pnpm lint') == -1, and edit_file >= -1 is true.
      expect(editIdx >= lintIdx).toBe(true);

      // hasAny works fine
      expect(seq.hasAny(['edit_file', 'write_file'])).toBe(true);
    });

    it('count() (turn-scoped) correctly counts edit_file in current turn', () => {
      // count() scans this.events (current turn), which works regardless of triologue
      expect(seq.count('edit_file')).toBe(1);
    });

    it('the condition works with count() as well (both count and totalCount give same result for single turn)', () => {
      // count() and totalCount() both work correctly now — totalCount uses the tally table
      const countBasedCondition =
        `(seq.count('edit_file') > 0 || seq.count('write_file') > 0) ` +
        `&& (seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') ` +
        `    || seq.lastIndexOf('write_file') >= seq.lastIndexOf('bash#pnpm lint') ` +
        `    || seq.lastIndexOf('bash#pnpm lint') == -1)`;

      expect(seq.evaluate(countBasedCondition)).toBe(true);
    });
  });

  // ==========================================================================
  // With Triologue (correct behavior)
  // ==========================================================================
  describe('with Triologue (correct behavior)', () => {
    let seq: Sequence;
    let triologue: Triologue;

    beforeEach(() => {
      triologue = buildTriologue();
      seq = new Sequence(triologue);
      for (const event of sessionEvents) {
        seq.add(event);
      }
    });

    it('totalCount("edit_file") returns correct count with Triologue', () => {
      expect(seq.totalCount('edit_file')).toBe(1);
    });

    it('totalCount("bash") returns correct count with Triologue', () => {
      // There are 4 bash tool messages in the triologue
      expect(seq.totalCount('bash')).toBe(4);
    });

    it('totalCount() returns correct session total with Triologue', () => {
      expect(seq.totalCount()).toBe(11);
    });

    it('evaluate() returns true when edit_file was used and no lint run', () => {
      // edit_file was used (totalCount > 0)
      // AND no pnpm lint was run (lastIndexOf == -1, so editIdx >= -1 is true)
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it('evaluate() returns false after pnpm lint is run', () => {
      // Simulate running pnpm lint after the edit
      seq.add({
        tool: 'bash',
        args: { command: 'pnpm lint', intent: 'lint' },
        result: '0 errors',
        timestamp: Date.now(),
      });

      // Now lint was run AFTER edit, so edit is NOT newer than lint
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(false);
    });

    it('evaluate() returns true if new edit after lint', () => {
      // Run lint first
      seq.add({
        tool: 'bash',
        args: { command: 'pnpm lint', intent: 'lint' },
        result: '0 errors',
        timestamp: Date.now(),
      });

      // Then make another edit
      seq.add({
        tool: 'edit_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: Date.now() + 1000,
      });

      // Now edit is AFTER lint, so condition should be true again
      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Empty sequence edge cases
  // ==========================================================================
  describe('empty sequence', () => {
    it('evaluate() returns false for empty sequence without Triologue', () => {
      const seq = new Sequence();
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });

    it('evaluate() returns false for empty sequence with Triologue', () => {
      const t = new Triologue();
      const seq = new Sequence(t);
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(false);
    });
  });

  // ==========================================================================
  // Only write_file (no edit_file) scenario
  // ==========================================================================
  describe('write_file scenario', () => {
    it('totalCount("write_file") returns correct count from tally table', () => {
      const seq = new Sequence();
      seq.add({
        tool: 'write_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: Date.now(),
      });

      expect(seq.totalCount('write_file')).toBe(1);
    });

    it('evaluate() returns true with Triologue for write_file-only scenario', () => {
      const t = new Triologue();
      // Inject a write_file tool message directly (bypassing microCompact)
      (t as any).addMessage({
        role: 'tool',
        tool_name: 'write_file',
        content: 'ok',
      });

      const seq = new Sequence(t);
      seq.add({
        tool: 'write_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: Date.now(),
      });

      expect(seq.totalCount('write_file')).toBe(1);
      expect(seq.evaluate(LINT_AFTER_EDIT_CONDITION)).toBe(true);
    });
  });

  // ==========================================================================
  // lastIndexOf comparisons verified independently
  // ==========================================================================
  describe('lastIndexOf comparison logic', () => {
    let seq: Sequence;

    beforeEach(() => {
      seq = new Sequence();
    });

    it('edit >= lint returns true when lint was never run (-1)', () => {
      seq.add({
        tool: 'edit_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: 1000,
      });

      const editIdx = seq.lastIndexOf('edit_file');
      const lintIdx = seq.lastIndexOf('bash#pnpm lint');
      expect(editIdx).toBeGreaterThanOrEqual(0);
      expect(lintIdx).toBe(-1);
      expect(editIdx >= lintIdx).toBe(true);

      const onlyLastPart = `(seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') || seq.lastIndexOf('bash#pnpm lint') == -1)`;
      expect(seq.evaluate(onlyLastPart)).toBe(true);
    });

    it('edit >= lint returns false when lint was run after edit', () => {
      seq.add({
        tool: 'edit_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: 1000,
      });
      seq.add({
        tool: 'bash',
        args: { command: 'pnpm lint', intent: 'lint' },
        result: '0 errors',
        timestamp: 2000,
      });

      const editIdx = seq.lastIndexOf('edit_file');
      const lintIdx = seq.lastIndexOf('bash#pnpm lint');
      expect(editIdx).toBe(0);
      expect(lintIdx).toBe(1);
      expect(editIdx >= lintIdx).toBe(false);

      const onlyLastPart = `(seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') || seq.lastIndexOf('bash#pnpm lint') == -1)`;
      expect(seq.evaluate(onlyLastPart)).toBe(false);
    });

    it('edit >= lint returns true when edit was run after lint', () => {
      seq.add({
        tool: 'bash',
        args: { command: 'pnpm lint', intent: 'lint' },
        result: '0 errors',
        timestamp: 1000,
      });
      seq.add({
        tool: 'edit_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: 2000,
      });

      const editIdx = seq.lastIndexOf('edit_file');
      const lintIdx = seq.lastIndexOf('bash#pnpm lint');
      expect(editIdx).toBe(1);
      expect(lintIdx).toBe(0);
      expect(editIdx >= lintIdx).toBe(true);
    });
  });

  // ==========================================================================
  // Evaluator robustness
  // ==========================================================================
  describe('evaluator robustness', () => {
    it('should handle complex boolean expression with many conditions', () => {
      const seq = new Sequence();
      seq.add({
        tool: 'edit_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: 1000,
      });

      const result = seq.evaluate(LINT_AFTER_EDIT_CONDITION);
      expect(result).toBe(true);
    });

    it('should not crash on deeply nested condition', () => {
      const seq = new Sequence();
      const expr = LINT_AFTER_EDIT_CONDITION;
      // Should at minimum not throw
      expect(() => seq.evaluate(expr)).not.toThrow();
    });

    it('should handle condition with only the lastIndexOf part', () => {
      const seq = new Sequence();
      seq.add({
        tool: 'edit_file',
        args: { path: 'test.ts' },
        result: 'ok',
        timestamp: 1000,
      });

      const lastPartOnly =
        `seq.lastIndexOf('edit_file') >= seq.lastIndexOf('bash#pnpm lint') ` +
        `|| seq.lastIndexOf('write_file') >= seq.lastIndexOf('bash#pnpm lint') ` +
        `|| seq.lastIndexOf('bash#pnpm lint') == -1`;

      expect(seq.evaluate(lastPartOnly)).toBe(true);
    });
  });

  // ==========================================================================
  // Session transcript data fidelity
  // ==========================================================================
  describe('session transcript data fidelity', () => {
    it('session transcript should contain 11 tool events', () => {
      expect(sessionEvents).toHaveLength(11);
    });

    it('tool event sequence should match expected pattern', () => {
      const toolNames = sessionEvents.map(e => e.tool);

      // The transcript shows: recall, recall, bash, bash, read_file, brief,
      // read_file, bash, bash, edit_file, brief
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('bash');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('recall');
      expect(toolNames).toContain('brief');
    });
  });
});
