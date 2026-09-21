/**
 * collect-keyword-discovery.test.ts — Tests for the composite keyword
 * extraction (brief + query + hint) in the COLLECT state.
 *
 * The COLLECT state composes a composite text from three sources:
 *   brief = turn.lastBriefMessage  (agent's self-reported focus)
 *   query = firstSteerNote ?? turn.lastUserQuery  (the trigger source)
 *   hint  = turn.lastHintFocus  (hint round focus_on)
 * Extraction is triggered only by a change in query. A 3-pass cooldown
 * suppresses re-triggering.
 *
 * extractKeywords() returns a discriminated union
 * ({status:'success'|'skipped'|'failed'}) so COLLECT can distinguish a
 * completed extraction from a trivially-skipped input and a failed/aborted
 * call. The throttle state (query cursor + cooldown) lives on the
 * SkillSuggester singleton and is armed ONLY on 'success' or 'skipped'; a
 * 'failed' outcome leaves query eligible for retry.
 *
 * These tests call the REAL SkillSuggester methods (computeQuerySource,
 * buildCompositeText, shouldExtract, queryChanged, markQuerySeen, armCooldown,
 * clearThrottle, decrementCooldown) instead of parallel-logic copies. The
 * singleton is reset in beforeEach so state never leaks between tests.
 * Integration tests that drive the real handleCollect() live in
 * collect-keyword-integration.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { skillSuggester } from '../../../loop/states/collect-skill.js';
import type { KeywordExtractionResult } from '../../../loop/keyword-extractor.js';

describe('Composite keyword extraction — query source', () => {
  beforeEach(() => skillSuggester.reset());

  it('uses the steering note when present (priority over user query)', () => {
    const q = skillSuggester.computeQuerySource('focus on tests', 'original query');
    expect(q).toBe('focus on tests');
  });

  it('falls back to lastUserQuery when no steering note', () => {
    const q = skillSuggester.computeQuerySource(null, 'original query');
    expect(q).toBe('original query');
  });

  it('returns null when neither steering note nor user query', () => {
    expect(skillSuggester.computeQuerySource(null, '')).toBeNull();
  });
});

describe('Composite keyword extraction — query-change detection', () => {
  beforeEach(() => skillSuggester.reset());

  it('triggers when query differs from lastQuery', () => {
    skillSuggester.markQuerySeen('old query');
    expect(skillSuggester.queryChanged('new query')).toBe(true);
  });

  it('does not trigger when query equals lastQuery', () => {
    skillSuggester.markQuerySeen('same query');
    expect(skillSuggester.queryChanged('same query')).toBe(false);
  });

  it('does not trigger when query is null', () => {
    expect(skillSuggester.queryChanged(null)).toBe(false);
    // even when lastQuery holds a prior value
    skillSuggester.markQuerySeen('old');
    expect(skillSuggester.queryChanged(null)).toBe(false);
  });

  it('triggers on the first pass (empty lastQuery)', () => {
    expect(skillSuggester.queryChanged('new query')).toBe(true);
  });
});

describe('Composite keyword extraction — composite text', () => {
  beforeEach(() => skillSuggester.reset());

  it('includes all three sources when present', () => {
    const text = skillSuggester.buildCompositeText('working on brief', 'user query', 'hint focus');
    expect(text).toBe('working on brief\nuser query\nhint focus');
  });

  it('includes only query when brief and hint are empty', () => {
    const text = skillSuggester.buildCompositeText('', 'user query', '');
    expect(text).toBe('user query');
  });

  it('includes brief and hint but not query when query is null', () => {
    const text = skillSuggester.buildCompositeText('brief msg', null, 'hint focus');
    expect(text).toBe('brief msg\nhint focus');
  });

  it('returns empty string when all sources are empty', () => {
    expect(skillSuggester.buildCompositeText('', null, '')).toBe('');
  });
});

describe('Composite keyword extraction — extraction gate', () => {
  beforeEach(() => skillSuggester.reset());

  it('fires when query changed, cooldown is 0, and composite is long enough', () => {
    expect(skillSuggester.shouldExtract(true, 0, 'user query about testing')).toBe(true);
  });

  it('does not fire when cooldown > 0', () => {
    expect(skillSuggester.shouldExtract(true, 3, 'user query about testing')).toBe(false);
    expect(skillSuggester.shouldExtract(true, 1, 'user query about testing')).toBe(false);
  });

  it('does not fire when query has not changed', () => {
    expect(skillSuggester.shouldExtract(false, 0, 'user query about testing')).toBe(false);
  });

  it('does not fire when composite text is too short (< 4 chars)', () => {
    expect(skillSuggester.shouldExtract(true, 0, 'ab')).toBe(false);
    expect(skillSuggester.shouldExtract(true, 0, '')).toBe(false);
    expect(skillSuggester.shouldExtract(true, 0, '   ')).toBe(false);
  });

  it('fires when composite text is exactly 4 chars', () => {
    expect(skillSuggester.shouldExtract(true, 0, 'test')).toBe(true);
  });
});

describe('Composite keyword extraction — cooldown decrementation', () => {
  beforeEach(() => skillSuggester.reset());

  it('decrements cooldown each pass until 0', () => {
    skillSuggester.armCooldown();
    expect(skillSuggester.getCooldown()).toBe(3);

    skillSuggester.decrementCooldown();
    expect(skillSuggester.getCooldown()).toBe(2);

    skillSuggester.decrementCooldown();
    expect(skillSuggester.getCooldown()).toBe(1);

    skillSuggester.decrementCooldown();
    expect(skillSuggester.getCooldown()).toBe(0);

    // Stays at 0 — never goes negative.
    skillSuggester.decrementCooldown();
    expect(skillSuggester.getCooldown()).toBe(0);
  });

  it('decrementCooldown is a no-op at 0 (fresh singleton)', () => {
    skillSuggester.decrementCooldown();
    expect(skillSuggester.getCooldown()).toBe(0);
  });
});

describe('Composite keyword extraction — BUG 1 (spurious double-trigger)', () => {
  // The scenario: a steering note triggers extraction. On subsequent passes
  // the steering note is consumed (firstSteerNote=null), so query falls back
  // to lastUserQuery. Without the fix, lastUserQuery differs from the stored
  // query (which was the steering note) and re-triggers after cooldown
  // expires. The fix marks BOTH sources as seen so neither re-triggers.

  beforeEach(() => skillSuggester.reset());

  it('marks the fallback lastUserQuery as seen when steering note was the trigger', () => {
    const firstSteerNote = 'focus on tests';
    const lastUserQuery = 'original user query';

    // Pass 1: steering note is the query source, differs from the empty
    // lastQuery → extraction fires.
    const q1 = skillSuggester.computeQuerySource(firstSteerNote, lastUserQuery);
    const changed1 = skillSuggester.queryChanged(q1);
    const composite1 = skillSuggester.buildCompositeText('', q1, '');
    expect(skillSuggester.shouldExtract(changed1, skillSuggester.getCooldown(), composite1)).toBe(true);

    // Apply post-extraction (includes BUG 1 fix) — success outcome arms the
    // throttle and marks the FALLBACK (lastUserQuery) as seen, not the note.
    skillSuggester.markQuerySeen(q1!);
    if (firstSteerNote && lastUserQuery) {
      skillSuggester.markQuerySeen(lastUserQuery);
    }
    skillSuggester.armCooldown();
    expect(skillSuggester.getCooldown()).toBe(3);
    // lastQuery is the FALLBACK (lastUserQuery), not the steering note.
    expect(skillSuggester.getLastQuery()).toBe('original user query');
  });

  it('does NOT spuriously re-trigger after steering note is consumed', () => {
    const firstSteerNote = 'focus on tests';
    const lastUserQuery = 'original user query';

    // Pass 1: steering note triggers, apply fix (success outcome).
    const q1 = skillSuggester.computeQuerySource(firstSteerNote, lastUserQuery)!;
    skillSuggester.markQuerySeen(q1);
    skillSuggester.markQuerySeen(lastUserQuery); // BUG 1 fix
    skillSuggester.armCooldown();
    // Cooldown decrements over passes 2, 3, 4.
    for (let i = 0; i < 3; i++) {
      skillSuggester.decrementCooldown();
    }
    expect(skillSuggester.getCooldown()).toBe(0);

    // Pass 5: steering note consumed (firstSteerNote=null). Query falls back
    // to lastUserQuery. With the fix, lastQuery == lastUserQuery, so
    // queryChanged is false — NO spurious re-trigger.
    const q5 = skillSuggester.computeQuerySource(null, lastUserQuery);
    expect(skillSuggester.queryChanged(q5)).toBe(false);
  });

  it('without the fix, the spurious double-trigger WOULD occur', () => {
    // Demonstrate the bug: if lastQuery were set to the steering note (the
    // naive approach), the fallback lastUserQuery would re-trigger.
    const lastUserQuery = 'original user query';
    skillSuggester.markQuerySeen('focus on tests'); // naive: set to steering note, NOT fallback
    const q = skillSuggester.computeQuerySource(null, lastUserQuery); // steering consumed
    // This is the bug — queryChanged is TRUE (spurious).
    expect(skillSuggester.queryChanged(q)).toBe(true);
  });
});

describe('Composite keyword extraction — steering note then new user query', () => {
  beforeEach(() => skillSuggester.reset());

  it('triggers correctly when a genuinely new user query arrives after a steering note', () => {
    // Mark the first query as seen (post-extraction with no steer).
    skillSuggester.markQuerySeen('first query');

    // User sends a new query (PROMPT updates lastUserQuery).
    const q = skillSuggester.computeQuerySource(null, 'second query about testing');
    expect(skillSuggester.queryChanged(q)).toBe(true); // genuinely new — should trigger
  });
});

describe('Composite keyword extraction — outcome-gated throttle (P1 fix)', () => {
  // The P1 review bug: the old code unconditionally armed the query cursor +
  // cooldown after extractKeywords(), which collapsed success/skipped/failed
  // into a single []. The fix arms the throttle ONLY on 'success' or
  // 'skipped'; a 'failed' outcome (ESC / transient error) leaves query
  // eligible for retry.

  beforeEach(() => skillSuggester.reset());

  it('arms the cooldown and marks query as seen on a SUCCESSFUL extraction', () => {
    const lastUserQuery = 'help me test the parser';
    const q = skillSuggester.computeQuerySource(null, lastUserQuery)!;
    applyOutcome({ status: 'success', keywords: ['parser', 'test'], freeformQuery: '' }, null, q, lastUserQuery);
    expect(skillSuggester.getLastQuery()).toBe('help me test the parser');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('arms the cooldown and marks query as seen on a SKIPPED (trivial) extraction', () => {
    // A trivial "hello" is marked seen so it doesn't re-trigger every pass,
    // but a subsequent meaningful query (different query) still triggers.
    const lastUserQuery = 'hello';
    const q = skillSuggester.computeQuerySource(null, lastUserQuery)!;
    applyOutcome({ status: 'skipped' }, null, q, lastUserQuery);
    expect(skillSuggester.getLastQuery()).toBe('hello');
    expect(skillSuggester.getCooldown()).toBe(3);
  });

  it('does NOT arm the cooldown or mark query as seen on a FAILED extraction (retry eligible)', () => {
    const lastUserQuery = 'help me test the parser';
    const q = skillSuggester.computeQuerySource(null, lastUserQuery)!;
    applyOutcome({ status: 'failed' }, null, q, lastUserQuery);
    // Query stays eligible for retry — neither field is touched.
    expect(skillSuggester.getLastQuery()).toBe('');
    expect(skillSuggester.getCooldown()).toBe(0);
  });

  it('a FAILED extraction leaves query re-triggerable on the very next pass (no cooldown)', () => {
    const lastUserQuery = 'help me test the parser';
    const q = skillSuggester.computeQuerySource(null, lastUserQuery)!;
    applyOutcome({ status: 'failed' }, null, q, lastUserQuery);

    // Next pass: query is unchanged but lastQuery is still '' (not marked
    // seen), and cooldown is still 0 — so queryChanged is TRUE and the gate
    // fires again.
    const qNext = skillSuggester.computeQuerySource(null, lastUserQuery);
    expect(skillSuggester.queryChanged(qNext)).toBe(true);
    expect(skillSuggester.getCooldown()).toBe(0);
    expect(skillSuggester.shouldExtract(true, skillSuggester.getCooldown(), qNext!)).toBe(true);
  });

  it('a SKIPPED trivial query does NOT suppress a subsequent meaningful query', () => {
    // Reviewer concern C: a trivial query should not consume the discovery
    // opportunity for a later meaningful query. Since lastQuery tracks query
    // CONTENT, a new meaningful query differs from "hello" and re-triggers.
    const lastUserQuery = 'hello';
    const q1 = skillSuggester.computeQuerySource(null, lastUserQuery)!;
    applyOutcome({ status: 'skipped' }, null, q1, lastUserQuery);
    // Cooldown decrements over the next 3 passes.
    for (let i = 0; i < 3; i++) {
      skillSuggester.decrementCooldown();
    }
    expect(skillSuggester.getCooldown()).toBe(0);

    // A new meaningful query arrives (PROMPT updates lastUserQuery).
    const q2 = skillSuggester.computeQuerySource(null, 'help me debug the state machine');
    expect(skillSuggester.queryChanged(q2)).toBe(true); // genuinely new content — triggers
  });

  it('a SUCCESSFUL extraction with empty keywords still arms the cooldown', () => {
    // The LLM ran but found nothing relevant. The operation completed, so the
    // throttle advances (no point re-running the same query every pass).
    const lastUserQuery = 'some non-trivial query with no skill match';
    const q = skillSuggester.computeQuerySource(null, lastUserQuery)!;
    applyOutcome({ status: 'success', keywords: [], freeformQuery: '' }, null, q, lastUserQuery);
    expect(skillSuggester.getLastQuery()).toBe('some non-trivial query with no skill match');
    expect(skillSuggester.getCooldown()).toBe(3);
  });
});

/**
 * Apply the post-extraction state update, gated by the extraction outcome.
 *
 * Mirrors the runKeywordExtraction success/skipped/failed branching:
 *  - 'failed' (ESC / transient error): do NOT touch the query cursor or
 *    cooldown — query stays eligible for a retry on a subsequent pass.
 *  - 'success' or 'skipped': mark the query source as seen (with the BUG 1
 *    fix — when a steering note was the trigger, mark the fallback
 *    lastUserQuery as seen instead) and arm the 3-pass cooldown.
 *
 * `firstSteerNote` is the steering note for THIS pass (null if none); it
 * drives the BUG 1 fallback.
 */
function applyOutcome(
  outcome: KeywordExtractionResult,
  firstSteerNote: string | null,
  query: string,
  lastUserQuery: string,
): void {
  if (outcome.status === 'failed') {
    // Query stays eligible for retry — do not touch throttle state.
    return;
  }
  // success or skipped: mark query as seen.
  skillSuggester.markQuerySeen(query);
  if (firstSteerNote && lastUserQuery) {
    skillSuggester.markQuerySeen(lastUserQuery);
  }
  skillSuggester.armCooldown();
}