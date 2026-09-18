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