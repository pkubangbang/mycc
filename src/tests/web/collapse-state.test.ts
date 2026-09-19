/**
 * collapse-state.test.ts - unit tests for the x / t / trackingTail reducer
 *
 * Pins the elastic-boundary state machine extracted from ChatLog.vue into a
 * pure module so the transitions are executable, not just manual reasoning.
 * Covers the exact scenario chain from the PR review:
 *   10/0/true +append → 10/0/true
 *   10/0/true +loadMore → 30/0/false
 *   30/0/false +5 appends → 30/5/false
 *   30/5/false +returnToTail → 35/0/true
 *   35/0/true +10 appends → 25/0/true
 *   25/0/true +enough appends → 10/0/true
 */
import { describe, it, expect } from 'vitest';
import {
  initialCollapseState,
  loadMore,
  returnToTail,
  leaveTail,
  onAppend,
  onShrink,
  onFilterChange,
  onHistoryReplace,
  classifyChange,
  applyObservation,
  windowSize,
  INITIAL_VISIBLE,
  MAX_VISIBLE,
} from '../../web/src/collapse-state.js';
import type { CollapseState } from '../../web/src/collapse-state.js';

function st(capacity: number, tailBuffer: number, trackingTail: boolean): CollapseState {
  return { capacity, tailBuffer, trackingTail };
}

describe('initialCollapseState', () => {
  it('starts at x=INITIAL_VISIBLE, t=0, tracking=true', () => {
    const s = initialCollapseState();
    expect(s.capacity).toBe(INITIAL_VISIBLE);
    expect(s.tailBuffer).toBe(0);
    expect(s.trackingTail).toBe(true);
  });
});

describe('onAppend — tracking the tail (self-trim toward floor)', () => {
  it('at the floor: append is a one-for-one swap (x stays 10, t stays 0)', () => {
    const s = onAppend(st(10, 0, true), 1).state;
    expect(s).toEqual(st(10, 0, true));
  });

  it('above the floor: trims capacity by delta', () => {
    const s = onAppend(st(35, 0, true), 10).state;
    expect(s).toEqual(st(25, 0, true));
  });

  it('trims toward the floor and bottoms out, then stays constant', () => {
    let s = st(25, 0, true);
    s = onAppend(s, 10).state; // 25 → 15
    expect(s).toEqual(st(15, 0, true));
    s = onAppend(s, 10).state; // 15 → 10 (floored)
    expect(s).toEqual(st(10, 0, true));
    s = onAppend(s, 10).state; // 10 → 10 (one-for-one swap)
    expect(s).toEqual(st(10, 0, true));
  });

  it('never trims capacity below INITIAL_VISIBLE', () => {
    const s = onAppend(st(12, 0, true), 100).state;
    expect(s.capacity).toBe(INITIAL_VISIBLE);
  });

  it('signals shouldScrollToTail=true (re-scroll even at the floor)', () => {
    // The review's P1: at the floor the rendered length is constant, so the
    // old length-watcher would not fire. The reducer explicitly signals a
    // re-scroll so the new tail message is guaranteed in view.
    expect(onAppend(st(10, 0, true), 1).shouldScrollToTail).toBe(true);
    expect(onAppend(st(35, 0, true), 10).shouldScrollToTail).toBe(true);
  });
});

describe('onAppend — away from the tail (buffer into t)', () => {
  it('buffers arrivals into t; capacity unchanged', () => {
    const s = onAppend(st(30, 0, false), 5).state;
    expect(s).toEqual(st(30, 5, false));
  });

  it('does NOT signal a re-scroll (viewed history stays put)', () => {
    expect(onAppend(st(30, 0, false), 5).shouldScrollToTail).toBe(false);
  });

  it('clamps (x + t) to MAX_VISIBLE by shrinking capacity first', () => {
    // x near the ceiling, t about to overflow the cap: drop oldest from the
    // window (shrink x toward the floor) before trimming t, preserving tail.
    const s = onAppend(st(MAX_VISIBLE - 5, 0, false), 20).state;
    expect(windowSize(s)).toBeLessThanOrEqual(MAX_VISIBLE);
    expect(s.tailBuffer).toBeGreaterThan(0);
    expect(s.capacity).toBeGreaterThanOrEqual(INITIAL_VISIBLE);
  });
});

describe('loadMore', () => {
  it('grows capacity by SCROLL_BATCH and leaves the tail', () => {
    const s = loadMore(st(10, 0, true));
    expect(s).toEqual(st(30, 0, false));
  });

  it('no-op when the window already shows the whole list', () => {
    const s = loadMore(st(10, 0, true), 8); // filteredLength=8 < window
    expect(s).toEqual(st(10, 0, true));
  });

  it('clamps capacity to MAX_VISIBLE', () => {
    let s = st(MAX_VISIBLE - 5, 0, false);
    s = loadMore(s);
    expect(s.capacity).toBe(MAX_VISIBLE);
  });
});

describe('returnToTail', () => {
  it('folds t into x (size-preserving) and clears t', () => {
    const s = returnToTail(st(30, 5, false));
    expect(s).toEqual(st(35, 0, true));
    // window size unchanged across the fold: 30+5 == 35+0
    expect(windowSize(st(30, 5, false))).toBe(windowSize(s));
  });

  it('with t=0 only flips tracking', () => {
    const s = returnToTail(st(30, 0, false));
    expect(s).toEqual(st(30, 0, true));
  });
});

describe('leaveTail', () => {
  it('flips tracking to false; x/t unchanged', () => {
    const s = leaveTail(st(30, 0, true));
    expect(s).toEqual(st(30, 0, false));
  });
});

describe('onShrink', () => {
  it('resets to the initial state', () => {
    expect(onShrink()).toEqual(initialCollapseState());
  });
});

describe('onFilterChange', () => {
  // The verbose-toggle transition (#14): the filtered set's membership
  // changed, not a genuine append/shrink. The old window position is no
  // longer meaningful, so reset to the initial window.
  it('resets an expanded+buffered state to the initial window', () => {
    // 30/5/false (user scrolled up, 5 buffered) → verbose toggle → 10/0/true
    expect(onFilterChange()).toEqual(initialCollapseState());
    expect(onFilterChange()).toEqual(st(INITIAL_VISIBLE, 0, true));
  });

  it('resets regardless of the incoming state (pure, argument-free)', () => {
    // onFilterChange takes no state arg — it is a policy decision, not a
    // delta. Confirm it always yields the initial state.
    expect(onFilterChange()).toEqual(onShrink());
  });
});

describe('onHistoryReplace', () => {
  // The #22 transition: an AUTHORITATIVE /history replacement (a 200 that
  // splices the chat arrays, or a session-change clear) bumped
  // historyRevision. The policy is the same as onShrink (reset to the
  // initial window — the old position is meaningless against a different
  // list), but kept as a separate reducer so the call site names the intent
  // unambiguously and the two policies may diverge.
  it('resets an expanded+buffered state to the initial window', () => {
    expect(onHistoryReplace()).toEqual(initialCollapseState());
    expect(onHistoryReplace()).toEqual(st(INITIAL_VISIBLE, 0, true));
  });

  it('resets regardless of the incoming state (pure, argument-free)', () => {
    expect(onHistoryReplace()).toEqual(onShrink());
  });
});

describe('classifyChange', () => {
  // classifyChange is the PURE decision the ChatLog watcher makes each time
  // it observes a new (verboseLogs, filteredLength) pair. These tests pin
  // the verbose-toggle-vs-append distinction that the prior two-watcher +
  // flag design got wrong (#15 stuck-flag, #16 scroll-after-reset). The
  // watcher is now a thin caller over this classifier, so these ARE the
  // watcher-level behavior tests — exercised without mounting a .vue SFC.

  it('initial observation (prev undefined) → none (keep INITIAL_VISIBLE)', () => {
    expect(classifyChange(undefined, true, undefined, 10)).toBe('none');
    expect(classifyChange(undefined, false, undefined, 0)).toBe('none');
  });

  it('verbose changed → filter, REGARDLESS of length delta', () => {
    // The #15 bug: a verbose toggle that left filteredLength IDENTICAL used
    // to leave the guard flag set, swallowing the next append. classifyChange
    // returns 'filter' even when length is unchanged, so the watcher runs
    // the filter branch (not nothing) and the next real append is processed
    // normally.
    expect(classifyChange(false, true, 10, 10)).toBe('filter');
    // verbose ON can grow the filtered set (log lines appear) — still filter
    expect(classifyChange(false, true, 20, 100)).toBe('filter');
    // verbose OFF can shrink it — still filter
    expect(classifyChange(true, false, 100, 20)).toBe('filter');
  });

  it('verbose unchanged & length grew → append (genuine tail arrivals)', () => {
    expect(classifyChange(true, true, 10, 11)).toBe('append');
    expect(classifyChange(false, false, 20, 25)).toBe('append');
  });

  it('verbose unchanged & length shrank → shrink (200-replace reset)', () => {
    expect(classifyChange(true, true, 100, 20)).toBe('shrink');
    expect(classifyChange(false, false, 30, 10)).toBe('shrink');
  });

  it('verbose unchanged & length same → none (content edit; leave window)', () => {
    expect(classifyChange(true, true, 10, 10)).toBe('none');
    expect(classifyChange(false, false, 0, 0)).toBe('none');
  });

  it('the #15 regression chain: filter (unchanged length) then a real append', () => {
    // Toggle verbose with NO log-only messages present (length unchanged).
    let prevV: boolean | undefined = false;
    let prevL: number | undefined = 10;
    // First observation is the initial run → none, advance tracked values.
    expect(classifyChange(prevV, false, prevL, 10)).toBe('none');
    prevV = false; prevL = 10;
    // Verbose ON, length still 10 (no log-only messages) → filter (NOT none).
    expect(classifyChange(prevV, true, prevL, 10)).toBe('filter');
    prevV = true; prevL = 10;
    // A REAL message now arrives (verbose unchanged, length 10→11) → append.
    // Under the old flag design this would have been swallowed; here it is
    // correctly classified as append.
    expect(classifyChange(prevV, true, prevL, 11)).toBe('append');
  });
});

describe('review scenario chain (end-to-end)', () => {
  it('walks the full x/t/trackingTail sequence from the review', () => {
    let s = initialCollapseState(); // 10/0/true
    // +append (tracking, at floor) → 10/0/true
    s = onAppend(s, 1).state;
    expect(s).toEqual(st(10, 0, true));
    // +loadMore → 30/0/false
    s = loadMore(s);
    expect(s).toEqual(st(30, 0, false));
    // +5 appends (away) → 30/5/false
    s = onAppend(s, 5).state;
    expect(s).toEqual(st(30, 5, false));
    // +returnToTail → 35/0/true
    s = returnToTail(s);
    expect(s).toEqual(st(35, 0, true));
    // +10 appends (tracking) → 25/0/true
    s = onAppend(s, 10).state;
    expect(s).toEqual(st(25, 0, true));
    // +enough appends → 10/0/true (bottoms out)
    s = onAppend(s, 100).state;
    expect(s).toEqual(st(10, 0, true));
  });
});

describe('applyObservation — the whole watcher body (round-8 integration)', () => {
  // applyObservation is the PURE state transition the ChatLog watcher runs on
  // every observed (verboseLogs, filteredLength) pair. It folds classifyChange
  // + the dispatch to onAppend/onShrink/onFilterChange + the shouldScrollToTail
  // signal (including the wasTrackingTail-before-reset capture) into ONE
  // function, so the FULL transition — not just the classifier — is testable.
  // These tests are the round-8 regression suite: #19 (delta=0) and #20
  // (first change dropped) lived in the watcher's manual prev-ref bookkeeping
  // and passed the suite because only classifyChange was covered.

  // helper: an observation tuple
  function obs(verbose: boolean, filteredLength: number) {
    return { verbose, filteredLength };
  }

  it('#19 — append uses the REAL prev length, so delta is non-zero', () => {
    // The bug: the watcher advanced prevFilteredLen BEFORE computing delta,
    // so 10→11 yielded delta=0 and onAppend no-op'd (no capacity trim, no
    // tailBuffer growth, no re-scroll signal). applyObservation takes the
    // previous observation as an argument, so delta = next - prev with the
    // real prev value.
    const state = st(35, 0, true); // tracking, above the floor
    const prev = obs(true, 10);
    const next = obs(true, 11);
    const { state: after, shouldScrollToTail } = applyObservation(prev, next, state);
    // delta=1 applied to 35/0/true → trims capacity by 1 → 34/0/true
    // (NOT the bug's no-op 35/0/true).
    expect(after).toEqual(st(34, 0, true));
    expect(shouldScrollToTail).toBe(true);
  });

  it('#19 — append at the floor still fires the re-scroll signal', () => {
    // 10/0/true + 1 arrival (delta must be 1, not 0): at the floor the
    // capacity can't trim, so x stays 10, but the re-scroll signal MUST fire
    // so the new tail message is scrolled into view (the floor-swap case).
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(true, 10),
      obs(true, 11),
      st(10, 0, true),
    );
    expect(after).toEqual(st(10, 0, true));
    expect(shouldScrollToTail).toBe(true);
  });

  it('#19 — append while scrolled up buffers into t (delta non-zero)', () => {
    // 30/0/false + 5 arrivals: buffers into t → 30/5/false, NO re-scroll.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(true, 30),
      obs(true, 35),
      st(30, 0, false),
    );
    expect(after).toEqual(st(30, 5, false));
    expect(shouldScrollToTail).toBe(false);
  });

  it('#20 — first real append (real prev, not undefined) is processed', () => {
    // The bug: the lazy watcher + undefined manual refs meant the FIRST real
    // change classified as 'none' and was dropped. Here the caller passes a
    // real prev observation (as Vue's (newValue, oldValue) signature does on
    // the first change), so the append runs.
    const prev = obs(true, 10); // the setup-time observation Vue captures
    const next = obs(true, 12); // first real change: 2 arrivals
    const { state: after, shouldScrollToTail } = applyObservation(
      prev,
      next,
      st(35, 0, true),
    );
    // delta=2 → 35 trims by 2 → 33/0/true, with re-scroll.
    expect(after).toEqual(st(33, 0, true));
    expect(shouldScrollToTail).toBe(true);
  });

  it('#20 — undefined prev (true first run) yields none, state unchanged', () => {
    // The total-guard: if a caller genuinely has no prior observation,
    // classifyChange returns 'none' and the state is returned unchanged.
    // (In ChatLog the watcher always has a real prev via Vue, but the guard
    // keeps applyObservation total.)
    const state = st(35, 5, false);
    const { state: after, shouldScrollToTail } = applyObservation(
      undefined,
      obs(true, 10),
      state,
    );
    expect(after).toBe(state); // same reference, untouched
    expect(shouldScrollToTail).toBe(false);
  });

  it('#16 — verbose toggle while tracking the tail re-scrolls', () => {
    // wasTrackingTail is captured BEFORE onFilterChange forces trackingTail
    // true. The user was following the tail → re-scroll so the newest
    // message stays in view after the membership change.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(false, 10),
      obs(true, 10), // verbose ON, length unchanged → filter
      st(30, 5, true), // tracking the tail
    );
    expect(after).toEqual(st(INITIAL_VISIBLE, 0, true)); // onFilterChange reset
    expect(shouldScrollToTail).toBe(true); // was tracking → re-scroll
  });

  it('#16 — verbose toggle while reading older history does NOT re-scroll', () => {
    // The user scrolled up (trackingTail=false) and toggled verbose: they
    // were reading older history, so the toggle must NOT throw them to the
    // newest message. wasTrackingTail=false is captured before the reset →
    // no re-scroll signal.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(false, 30),
      obs(true, 30), // verbose ON, length unchanged → filter
      st(30, 5, false), // NOT tracking (reading older history)
    );
    expect(after).toEqual(st(INITIAL_VISIBLE, 0, true)); // still resets the window
    expect(shouldScrollToTail).toBe(false); // but no scroll-to-tail
  });

  it('shrink (200-replace) resets to the initial window, no re-scroll', () => {
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(true, 100),
      obs(true, 20), // length shrank, verbose unchanged → shrink
      st(30, 5, false),
    );
    expect(after).toEqual(initialCollapseState());
    expect(shouldScrollToTail).toBe(false);
  });

  it('none (content edit, same length + same verbose) leaves the state untouched', () => {
    const state = st(30, 5, false);
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(true, 30),
      obs(true, 30), // unchanged → none
      state,
    );
    expect(after).toBe(state);
    expect(shouldScrollToTail).toBe(false);
  });

  it('verbose change WINS over a concurrent length change (filter, not append)', () => {
    // classifyChange prioritizes a verbose change over a length delta, so a
    // verbose toggle that also grew the list is a 'filter' (membership
    // changed), not an 'append'. applyObservation must dispatch to the
    // filter branch (reset + wasTrackingTail signal), NOT onAppend.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(false, 10),
      obs(true, 50), // verbose ON grew the list, but verbose changed → filter
      st(35, 0, true),
    );
    expect(after).toEqual(st(INITIAL_VISIBLE, 0, true)); // filter reset, NOT append trim
    expect(shouldScrollToTail).toBe(true);
  });

  // ── #22: history-revision reset (authoritative /history replacement) ──

  it('#22 — same verbose + same length + historyReplaced → reset (the core P1)', () => {
    // The bug: a /history 200 that replaced the store with a list of the
    // SAME filtered length (e.g. the server's 1000-entry cap: old entries
    // leave + new enter → count stays 1000) classified as 'none' and kept a
    // now-invalid window. The historyReplaced signal makes it an
    // unconditional reset regardless of cardinality.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(false, 1000),
      obs(false, 1000), // identical observation by cardinality/verbose…
      st(50, 20, false), // …but the list was authoritatively replaced
      true, // historyReplaced
    );
    expect(after).toEqual(initialCollapseState()); // reset
    expect(shouldScrollToTail).toBe(true); // re-scroll to the new tail
  });

  it('#22 — historyReplaced WINS over a concurrent append (revision is highest priority)', () => {
    // A /history 200 can also grow the list (more history than before). The
    // revision change must take priority over the append classification —
    // the replacement is the authoritative event, not a tail arrival.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(true, 10),
      obs(true, 50), // length grew → would classify as 'append'…
      st(35, 0, true),
      true, // …but historyReplaced overrides → reset
    );
    expect(after).toEqual(initialCollapseState()); // reset, NOT append trim
    expect(shouldScrollToTail).toBe(true);
  });

  it('#22 — historyReplaced WINS over a concurrent verbose toggle', () => {
    // A 200 replacement can coincide with a verbose change in the same
    // render cycle. The revision change takes priority over the filter
    // classification too.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(false, 1000),
      obs(true, 1000), // verbose changed → would classify as 'filter'…
      st(30, 5, false),
      true, // …but historyReplaced overrides → reset
    );
    expect(after).toEqual(initialCollapseState());
    expect(shouldScrollToTail).toBe(true);
  });

  it('#22 — historyReplaced=false + length grew → normal append (revision does not interfere)', () => {
    // The default (historyReplaced=false) path is unchanged: a normal tail
    // arrival with no revision bump is still an append, not a reset. This
    // guards against the revision signal accidentally suppressing appends.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(true, 10),
      obs(true, 11),
      st(35, 0, true),
      false,
    );
    expect(after).toEqual(st(34, 0, true)); // append trim, NOT reset
    expect(shouldScrollToTail).toBe(true);
  });

  it('#22 — historyReplaced=false (default) preserves the prior behavior exactly', () => {
    // The historyReplaced parameter defaults to false, so existing callers
    // (and existing tests) that omit it get the unchanged transition. Pin a
    // verbose-toggle case to confirm the default does not alter the filter
    // branch's wasTrackingTail behaviour.
    const { state: after, shouldScrollToTail } = applyObservation(
      obs(false, 30),
      obs(true, 30),
      st(30, 5, false), // reading older history (not tracking)
      // historyReplaced omitted → defaults to false
    );
    expect(after).toEqual(st(INITIAL_VISIBLE, 0, true)); // filter reset
    expect(shouldScrollToTail).toBe(false); // was NOT tracking → no re-scroll
  });
});