/**
 * turn-boundary-at-stop.test.ts
 *
 * Tests the revised turn.* / totalTurns() semantics introduced by the
 * turn-session-semantics-revision plan:
 *
 *   - turn.*       : events since last turn boundary (STOP→PROMPT).
 *                    Survives compaction (compactReset does NOT clear it).
 *   - session.*    : events in current livelog. Cleared by compactReset().
 *   - totalTurns() : number of completed turns (STOP→PROMPT cycles).
 *                    Survives compaction. Reset only by fullClear().
 *
 * The turn boundary is markPromptBoundary() (clears turn.events[]) paired
 * with incrementTotalTurns() (advances the counter), both called at the
 * STOP→PROMPT return sites in stop.ts. STOP→COLLECT (teammate mail /
 * steering / timeout) is a CONTINUATION — neither fires there.
 *
 * These tests exercise the Sequence API directly (the contract the state
 * machine relies on). The state-machine wiring (stop.ts calling these
 * methods at the right return sites) is verified by tsc + the prompt-autofly
 * and esc-loop integration tests.
 */

import { describe, it, expect } from 'vitest';
import { Sequence } from '../../hook/sequence.js';

describe('turn-boundary-at-stop: revised turn.*/totalTurns semantics', () => {
  // Helper: simulate a tool call being recorded (as the TOOL state does via
  // sequence.add()).
  function addTool(seq: Sequence, tool: string, result = 'OK'): void {
    seq.add({
      tool,
      args: {},
      result,
      timestamp: Date.now(),
    });
  }

  // Helper: simulate the STOP→PROMPT turn boundary (as stop.ts does via the
  // markTurnBoundary closure).
  function stopToPrompt(seq: Sequence): void {
    seq.markPromptBoundary();
    seq.incrementTotalTurns();
  }

  it('Scenario 1: normal turn — STOP→PROMPT clears turn.* and increments totalTurns', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // Turn 1: user query → 3 tool calls → STOP → PROMPT
    addTool(seq, 'bash');
    addTool(seq, 'read_file');
    addTool(seq, 'edit_file');
    expect(seq.turnCount()).toBe(3);
    expect(seq.getTotalTurns()).toBe(0);

    stopToPrompt(seq);
    expect(seq.turnCount()).toBe(0);   // cleared at boundary
    expect(seq.getTotalTurns()).toBe(1); // incremented at boundary
  });

  it('Scenario 2: STOP→COLLECT is a continuation — turn.* NOT cleared, totalTurns NOT incremented', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // Turn 1: query → 3 tool calls → STOP → COLLECT (teammate mail) → 2 more → STOP → PROMPT
    addTool(seq, 'bash');
    addTool(seq, 'read_file');
    addTool(seq, 'edit_file');
    expect(seq.turnCount()).toBe(3);
    expect(seq.getTotalTurns()).toBe(0);

    // STOP→COLLECT: NO boundary fires (continuation)
    // (stop.ts returns COLLECT without calling markPromptBoundary/incrementTotalTurns)
    addTool(seq, 'edit_file');
    addTool(seq, 'bash');
    expect(seq.turnCount()).toBe(5);     // still accumulating — NOT cleared
    expect(seq.getTotalTurns()).toBe(0); // NOT incremented

    // Final STOP→PROMPT: boundary fires
    stopToPrompt(seq);
    expect(seq.turnCount()).toBe(0);   // cleared at final boundary
    expect(seq.getTotalTurns()).toBe(1); // one completed turn (the whole cycle)
  });

  it('Scenario 3: compaction mid-turn — turn.* survives compactReset, session.* does not', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // query → 3 tool calls → compaction → 2 tool calls → STOP → PROMPT
    addTool(seq, 'bash');
    addTool(seq, 'read_file');
    addTool(seq, 'edit_file');
    expect(seq.turnCount()).toBe(3);
    expect(seq.sessionCount()).toBe(3);

    // Compaction fires mid-turn (llm.ts auto-compact → compactReset)
    seq.compactReset();
    // turn.* SURVIVES compaction (revised semantics):
    expect(seq.turnCount()).toBe(3);
    // session.* is cleared by compactReset:
    expect(seq.sessionCount()).toBe(0);
    // totalTurns NOT reset by compaction:
    expect(seq.getTotalTurns()).toBe(0);

    // Continue the same turn: 2 more tool calls
    addTool(seq, 'edit_file');
    addTool(seq, 'bash');
    // turn.* sees ALL tool calls (pre + post compact):
    expect(seq.turnCount()).toBe(5);
    // session.* sees only post-compact:
    expect(seq.sessionCount()).toBe(2);

    // STOP→PROMPT: boundary fires
    stopToPrompt(seq);
    expect(seq.turnCount()).toBe(0);
    expect(seq.getTotalTurns()).toBe(1);
  });

  it('Scenario 4: daemon mode — boundary at STOP→PROMPT clears turn.* (the bug fix)', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // Daemon cycle: AWAIT → COLLECT → 2 tool calls → STOP → PROMPT → AWAIT
    // (In daemon mode PROMPT short-circuits to AWAIT before markPromptBoundary,
    //  so WITHOUT the STOP boundary turn.* would never clear.)
    addTool(seq, 'bash');
    addTool(seq, 'edit_file');
    expect(seq.turnCount()).toBe(2);
    expect(seq.getTotalTurns()).toBe(0);

    // STOP→PROMPT: boundary fires (the fix — previously this never happened
    // in daemon mode because PROMPT→AWAIT skipped markPromptBoundary)
    stopToPrompt(seq);
    expect(seq.turnCount()).toBe(0);
    expect(seq.getTotalTurns()).toBe(1);

    // Next daemon cycle starts fresh:
    addTool(seq, 'read_file');
    expect(seq.turnCount()).toBe(1);
    stopToPrompt(seq);
    expect(seq.getTotalTurns()).toBe(2);
  });

  it('Scenario 5: fullClear() resets totalTurns; compactReset does not', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // Complete 3 turns
    for (let i = 0; i < 3; i++) {
      addTool(seq, 'bash');
      stopToPrompt(seq);
    }
    expect(seq.getTotalTurns()).toBe(3);

    // compactReset does NOT reset totalTurns
    seq.compactReset();
    expect(seq.getTotalTurns()).toBe(3);

    // fullClear (used by /clear, double-Ctrl+L) resets everything
    seq.fullClear();
    expect(seq.getTotalTurns()).toBe(0);
    expect(seq.turnCount()).toBe(0);
    expect(seq.sessionCount()).toBe(0);
  });

  it('totalTurns() is evaluable in hook conditions', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // Initially 0 turns
    expect(seq.evaluate('totalTurns() >= 5')).toBe(false);
    expect(seq.evaluate('totalTurns() == 0')).toBe(true);

    // Complete 5 turns
    for (let i = 0; i < 5; i++) {
      addTool(seq, 'bash');
      stopToPrompt(seq);
    }
    expect(seq.getTotalTurns()).toBe(5);
    // At hook-evaluation time (HOOK state, before STOP), totalTurns reflects
    // completed turns. After 5 completed turns, >= 5 is true (fires on 6th).
    expect(seq.evaluate('totalTurns() >= 5')).toBe(true);
    expect(seq.evaluate('totalTurns() > 5')).toBe(false);
  });

  it('totalTurns() survives compaction in a hook condition', () => {
    const seq = new Sequence(undefined, () => 'normal');
    // Complete 3 turns
    for (let i = 0; i < 3; i++) {
      addTool(seq, 'bash');
      stopToPrompt(seq);
    }
    expect(seq.evaluate('totalTurns() == 3')).toBe(true);

    // Compaction mid-turn — totalTurns survives
    addTool(seq, 'bash');
    seq.compactReset();
    expect(seq.evaluate('totalTurns() == 3')).toBe(true);
  });

  it('markPromptBoundary() clears turn.* but does NOT increment totalTurns', () => {
    // This verifies the separation: markPromptBoundary is events-only.
    // incrementTotalTurns is a separate call (stop.ts calls both at STOP→PROMPT).
    const seq = new Sequence(undefined, () => 'normal');
    addTool(seq, 'bash');
    addTool(seq, 'edit_file');
    expect(seq.turnCount()).toBe(2);
    expect(seq.getTotalTurns()).toBe(0);

    // markPromptBoundary alone (e.g. the PROMPT fallback path) clears events
    // but does NOT increment totalTurns:
    seq.markPromptBoundary();
    expect(seq.turnCount()).toBe(0);
    expect(seq.getTotalTurns()).toBe(0); // NOT incremented by markPromptBoundary
  });
});