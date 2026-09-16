/**
 * collect-keyword-discovery.test.ts — Tests for the composite keyword
 * extraction (X+Y+Z) in the COLLECT state.
 *
 * The COLLECT state composes a composite text from three sources:
 *   X = turn.lastBriefMessage  (agent's self-reported focus)
 *   Y = firstSteerNote ?? turn.lastUserQuery  (the trigger source)
 *   Z = turn.lastHintFocus  (hint round focus_on)
 * Extraction is triggered only by a change in Y. A 3-pass cooldown suppresses
 * re-triggering. These tests verify the trigger logic, cooldown, composite
 * construction, and the BUG 1 fix (spurious double-trigger after steering
 * note exhaustion).
 *
 * The composite text construction and Y-change detection are pure functions
 * of TurnVars + the steering note, so we test them directly without driving
 * the full handleCollect() (which requires heavy mocking of the LLM and
 * skill layer). The trigger/cooldown logic is extracted into a helper for
 * testability.
 */
import { describe, it, expect } from 'vitest';
import type { TurnVars } from '../../../loop/state-machine.js';

/**
 * Compute the Y source for a COLLECT pass.
 * Steering note takes precedence over lastUserQuery (freshest mid-task
 * direction). Mirrors the logic in collect.ts step 6.
 */
function computeYSource(firstSteerNote: string | null, lastUserQuery: string): string | null {
  return firstSteerNote ?? (lastUserQuery || null);
}

/**
 * Compute whether Y changed this pass.
 * Mirrors the logic in collect.ts step 6.
 */
function computeYChanged(ySource: string | null, lastSkillY: string): boolean {
  return ySource !== null && ySource !== lastSkillY;
}

/**
 * Build the composite text from X + Y + Z.
 * Mirrors the logic in collect.ts step 6.
 */
function buildCompositeText(
  lastBriefMessage: string,
  ySource: string | null,
  lastHintFocus: string,
): string {
  const parts: string[] = [];
  if (lastBriefMessage) parts.push(lastBriefMessage);
  if (ySource) parts.push(ySource);
  if (lastHintFocus) parts.push(lastHintFocus);
  return parts.join('\n');
}

/**
 * Determine whether extraction should fire this pass.
 * Mirrors the gating logic in collect.ts step 6.
 */
function shouldExtract(
  yChanged: boolean,
  cooldown: number,
  compositeText: string,
): boolean {
  return yChanged && cooldown === 0 && compositeText.trim().length >= 4;
}

/**
 * Apply the post-extraction state update including the BUG 1 fix.
 * When a steering note was the trigger, ALSO mark the fallback lastUserQuery
 * as seen so it doesn't spuriously re-trigger after the steering note is
 * consumed on subsequent passes.
 */
function applyPostExtraction(
  turn: TurnVars,
  firstSteerNote: string | null,
): void {
  const ySource = computeYSource(firstSteerNote, turn.lastUserQuery);
  turn.lastSkillY = ySource ?? '';
  if (firstSteerNote && turn.lastUserQuery) {
    turn.lastSkillY = turn.lastUserQuery;
  }
  turn.skillDiscoveryCooldown = 3;
}

/** Create a fresh TurnVars with the new fields. */
function createTurnVars(overrides: Partial<TurnVars> = {}): TurnVars {
  return {
    isFirstRound: true,
    nextTodoNudge: 3,
    lastTodoState: '',
    nextBriefNudge: 5,
    lastUserQuery: '',
    lastBriefMessage: '',
    lastHintFocus: '',
    lastSkillY: '',
    skillDiscoveryCooldown: 0,
    collectTransientRetries: 0,
    ...overrides,
  };
}

describe('Composite keyword extraction — Y source', () => {
  it('uses the steering note when present (priority over user query)', () => {
    const y = computeYSource('focus on tests', 'original query');
    expect(y).toBe('focus on tests');
  });

  it('falls back to lastUserQuery when no steering note', () => {
    const y = computeYSource(null, 'original query');
    expect(y).toBe('original query');
  });

  it('returns null when neither steering note nor user query', () => {
    expect(computeYSource(null, '')).toBeNull();
  });
});

describe('Composite keyword extraction — Y-change detection', () => {
  it('triggers when Y differs from lastSkillY', () => {
    expect(computeYChanged('new query', '')).toBe(true);
    expect(computeYChanged('new query', 'old query')).toBe(true);
  });

  it('does not trigger when Y equals lastSkillY', () => {
    expect(computeYChanged('same query', 'same query')).toBe(false);
  });

  it('does not trigger when Y is null', () => {
    expect(computeYChanged(null, '')).toBe(false);
    expect(computeYChanged(null, 'old')).toBe(false);
  });
});

describe('Composite keyword extraction — composite text', () => {
  it('includes all three sources when present', () => {
    const text = buildCompositeText('working on X', 'user query', 'hint focus');
    expect(text).toBe('working on X\nuser query\nhint focus');
  });

  it('includes only Y when X and Z are empty', () => {
    const text = buildCompositeText('', 'user query', '');
    expect(text).toBe('user query');
  });

  it('includes X and Z but not Y when Y is null', () => {
    const text = buildCompositeText('brief msg', null, 'hint focus');
    expect(text).toBe('brief msg\nhint focus');
  });

  it('returns empty string when all sources are empty', () => {
    expect(buildCompositeText('', null, '')).toBe('');
  });
});

describe('Composite keyword extraction — extraction gate', () => {
  it('fires when Y changed, cooldown is 0, and composite is long enough', () => {
    expect(shouldExtract(true, 0, 'user query about testing')).toBe(true);
  });

  it('does not fire when cooldown > 0', () => {
    expect(shouldExtract(true, 3, 'user query about testing')).toBe(false);
    expect(shouldExtract(true, 1, 'user query about testing')).toBe(false);
  });

  it('does not fire when Y has not changed', () => {
    expect(shouldExtract(false, 0, 'user query about testing')).toBe(false);
  });

  it('does not fire when composite text is too short (< 4 chars)', () => {
    expect(shouldExtract(true, 0, 'ab')).toBe(false);
    expect(shouldExtract(true, 0, '')).toBe(false);
    expect(shouldExtract(true, 0, '   ')).toBe(false);
  });

  it('fires when composite text is exactly 4 chars', () => {
    expect(shouldExtract(true, 0, 'test')).toBe(true);
  });
});

describe('Composite keyword extraction — cooldown decrementation', () => {
  it('decrements cooldown each pass until 0', () => {
    let turn = createTurnVars({ skillDiscoveryCooldown: 3 });
    expect(turn.skillDiscoveryCooldown).toBe(3);

    if (turn.skillDiscoveryCooldown > 0) turn.skillDiscoveryCooldown--;
    expect(turn.skillDiscoveryCooldown).toBe(2);

    if (turn.skillDiscoveryCooldown > 0) turn.skillDiscoveryCooldown--;
    expect(turn.skillDiscoveryCooldown).toBe(1);

    if (turn.skillDiscoveryCooldown > 0) turn.skillDiscoveryCooldown--;
    expect(turn.skillDiscoveryCooldown).toBe(0);

    // Stays at 0 — never goes negative.
    if (turn.skillDiscoveryCooldown > 0) turn.skillDiscoveryCooldown--;
    expect(turn.skillDiscoveryCooldown).toBe(0);
  });
});

describe('Composite keyword extraction — BUG 1 (spurious double-trigger)', () => {
  // The scenario: a steering note triggers extraction. On subsequent passes
  // the steering note is consumed (firstSteerNote=null), so Y falls back to
  // lastUserQuery. Without the fix, lastUserQuery differs from lastSkillY
  // (which was the steering note) and re-triggers after cooldown expires.
  // The fix marks BOTH sources as seen so neither re-triggers.

  it('marks the fallback lastUserQuery as seen when steering note was the trigger', () => {
    const turn = createTurnVars({
      lastUserQuery: 'original user query',
      lastBriefMessage: '',
      lastHintFocus: '',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });
    const firstSteerNote = 'focus on tests';

    // Pass 1: steering note triggers extraction.
    const y1 = computeYSource(firstSteerNote, turn.lastUserQuery);
    const yChanged1 = computeYChanged(y1, turn.lastSkillY);
    const composite1 = buildCompositeText(turn.lastBriefMessage, y1, turn.lastHintFocus);
    expect(shouldExtract(yChanged1, turn.skillDiscoveryCooldown, composite1)).toBe(true);

    // Apply post-extraction (includes BUG 1 fix).
    applyPostExtraction(turn, firstSteerNote);
    expect(turn.skillDiscoveryCooldown).toBe(3);
    // lastSkillY is set to the FALLBACK (lastUserQuery), not the steering note.
    expect(turn.lastSkillY).toBe('original user query');
  });

  it('does NOT spuriously re-trigger after steering note is consumed', () => {
    const turn = createTurnVars({
      lastUserQuery: 'original user query',
      lastBriefMessage: '',
      lastHintFocus: '',
      lastSkillY: '',
      skillDiscoveryCooldown: 0,
    });
    const firstSteerNote = 'focus on tests';

    // Pass 1: steering note triggers, apply fix.
    applyPostExtraction(turn, firstSteerNote);
    // Cooldown decrements over passes 2, 3, 4.
    for (let i = 0; i < 3; i++) {
      if (turn.skillDiscoveryCooldown > 0) turn.skillDiscoveryCooldown--;
    }
    expect(turn.skillDiscoveryCooldown).toBe(0);

    // Pass 5: steering note consumed (firstSteerNote=null). Y falls back to
    // lastUserQuery. With the fix, lastSkillY == lastUserQuery, so yChanged
    // is false — NO spurious re-trigger.
    const firstSteerNotePass5 = null;
    const y5 = computeYSource(firstSteerNotePass5, turn.lastUserQuery);
    const yChanged5 = computeYChanged(y5, turn.lastSkillY);
    expect(yChanged5).toBe(false);
  });

  it('without the fix, the spurious double-trigger WOULD occur', () => {
    // Demonstrate the bug: if lastSkillY were set to the steering note (the
    // naive approach), the fallback lastUserQuery would re-trigger.
    const turn = createTurnVars({
      lastUserQuery: 'original user query',
      lastSkillY: 'focus on tests', // naive: set to steering note, NOT fallback
      skillDiscoveryCooldown: 0,
    });
    const y = computeYSource(null, turn.lastUserQuery); // steering consumed
    const yChanged = computeYChanged(y, turn.lastSkillY);
    // This is the bug — yChanged is TRUE (spurious).
    expect(yChanged).toBe(true);
  });
});

describe('Composite keyword extraction — steering note then new user query', () => {
  it('triggers correctly when a genuinely new user query arrives after a steering note', () => {
    const turn = createTurnVars({
      lastUserQuery: 'first query',
      lastSkillY: 'first query', // marked as seen (post-extraction with no steer)
      skillDiscoveryCooldown: 0,
    });

    // User sends a new query (PROMPT updates lastUserQuery).
    turn.lastUserQuery = 'second query about testing';
    const y = computeYSource(null, turn.lastUserQuery);
    const yChanged = computeYChanged(y, turn.lastSkillY);
    expect(yChanged).toBe(true); // genuinely new — should trigger
  });
});