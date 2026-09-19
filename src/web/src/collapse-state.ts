/**
 * collapse-state.ts - pure reducer for the chatlog collapse window (x / t / trackingTail)
 *
 * Extracted from ChatLog.vue so the elastic-boundary state machine is directly
 * unit-testable in node (a `.vue` SFC is not importable here). ChatLog.vue
 * holds the reactive refs (capacity / tailBuffer / trackingTail) and calls
 * these pure transitions; the DOM/scroll side-effects stay in the component.
 *
 * MODEL
 *   x (capacity)     — steady-state rendered window size. Starts at
 *                      INITIAL_VISIBLE, grows by SCROLL_BATCH on loadMore,
 *                      self-trims by `delta` per tail append while tracking
 *                      so a long idle-with-tail session does not render an
 *                      ever-growing window. Floor INITIAL_VISIBLE, ceiling
 *                      MAX_VISIBLE.
 *   t (tail buffer)  — new messages arriving WHILE scrolled up (not tracking)
 *                      are buffered here. Still rendered (window = last x+t)
 *                      but below the viewport, so viewed history stays stable.
 *   trackingTail     — whether the user is pinned to the live tail.
 *
 * INVARIANT: rendered window = last (x + t) of the filtered list, always.
 *
 * Worked example (INITIAL_VISIBLE=10, SCROLL_BATCH=20):
 *   10/0/true +append      → 10/0/true   (swap one-for-one at the floor)
 *   10/0/true +loadMore    → 30/0/false  (reveal older; leave the tail)
 *   30/0/false +5 appends  → 30/5/false  (buffer; viewed history stable)
 *   30/5/false +returnTail → 35/0/true   (fold t into x, size-preserving)
 *   35/0/true +10 appends  → 25/0/true   (trim toward the floor)
 *   25/0/true +more        → 10/0/true   (bottoms out, then constant)
 */

/** Configuration constants for the collapse window. */
export const INITIAL_VISIBLE = 10;
export const SCROLL_BATCH = 20;
/** Hard ceiling on (x + t), mirroring the server's MAX_LOG_SIZE (1000). */
export const MAX_VISIBLE = 1000;

/** The three pieces of collapse view state. */
export interface CollapseState {
  /** x — steady-state capacity. */
  capacity: number;
  /** t — tail buffer (arrivals while away from the tail). */
  tailBuffer: number;
  /** Whether the user is pinned to the live tail. */
  trackingTail: boolean;
}

/** A fresh initial state: x=INITIAL_VISIBLE, t=0, tracking the tail. */
export function initialCollapseState(): CollapseState {
  return { capacity: INITIAL_VISIBLE, tailBuffer: 0, trackingTail: true };
}

/** Total rendered window size (x + t), clamped to MAX_VISIBLE. */
export function windowSize(s: CollapseState): number {
  return Math.min(s.capacity + s.tailBuffer, MAX_VISIBLE);
}

/**
 * loadMore — the user scrolled up / clicked "load more" to reveal older
 * history. Leaves the tail (trackingTail = false) and grows capacity by
 * SCROLL_BATCH, clamped to MAX_VISIBLE. No-op if capacity already covers
 * the whole list (no older messages to reveal).
 *
 * `filteredLength` is the current filtered-list size; if the window already
 * shows everything there is nothing to expand.
 */
export function loadMore(
  s: CollapseState,
  filteredLength: number = Number.POSITIVE_INFINITY,
): CollapseState {
  if (windowSize(s) >= filteredLength) return s; // nothing collapsed above
  const capacity = Math.min(s.capacity + SCROLL_BATCH, MAX_VISIBLE);
  return { capacity, tailBuffer: s.tailBuffer, trackingTail: false };
}

/**
 * returnToTail — the user returned to the live tail (scroll-to-bottom or
 * scrolled to the bottom). Folds the tail buffer into capacity
 * (x += t, size-preserving across the fold) and clears it, then marks
 * tracking. Clamp the resulting capacity to MAX_VISIBLE.
 */
export function returnToTail(s: CollapseState): CollapseState {
  if (s.tailBuffer === 0) return { ...s, trackingTail: true };
  const capacity = Math.min(s.capacity + s.tailBuffer, MAX_VISIBLE);
  return { capacity, tailBuffer: 0, trackingTail: true };
}

/**
 * leaveTail — the user scrolled away from the bottom. No longer tracking;
 * future arrivals buffer into t. (No x/t change here — only the flag flips.)
 */
export function leaveTail(s: CollapseState): CollapseState {
  return { ...s, trackingTail: false };
}

/**
 * onAppend — `delta` new filtered messages arrived. The core transition:
 *   - tracking: trim capacity by `delta` toward INITIAL_VISIBLE so the
 *     window self-contracts over time (each arrival "trades 2 old for 1
 *     new" until x bottoms out, then swaps one-for-one). Buffer unchanged.
 *   - not tracking: buffer the arrivals into t (viewed history stable);
 *     clamp (x + t) to MAX_VISIBLE by shrinking capacity if the cap is hit.
 * Returns the new state AND whether the tail should be re-scrolled (true
 * when tracking — the caller scrolls to bottom so the new message is in
 * view even when the rendered length stayed constant at the floor).
 */
export function onAppend(
  s: CollapseState,
  delta: number,
): { state: CollapseState; shouldScrollToTail: boolean } {
  if (delta <= 0) return { state: s, shouldScrollToTail: false };
  if (s.trackingTail) {
    // Trim capacity toward the floor. Net window change: -(delta) (the
    // oldest `delta` rendered messages drop off the top, the new ones enter
    // at the bottom). Once at the floor, the window is constant and each
    // arrival is a one-for-one swap.
    const capacity = Math.max(s.capacity - delta, INITIAL_VISIBLE);
    return {
      state: { capacity, tailBuffer: 0, trackingTail: true },
      // Re-scroll even when the rendered length is unchanged (the floor
      // swap case) so the new tail message is guaranteed in view.
      shouldScrollToTail: true,
    };
  }
  // Not tracking: buffer into t, clamp (x + t) to MAX_VISIBLE.
  let capacity = s.capacity;
  let tailBuffer = s.tailBuffer + delta;
  const over = capacity + tailBuffer - MAX_VISIBLE;
  if (over > 0) {
    // Drop the oldest from the window by shrinking capacity (never below the
    // floor) before trimming t, so the live tail is preserved.
    const capCut = Math.min(over, capacity - INITIAL_VISIBLE);
    capacity -= capCut;
    tailBuffer -= over - capCut;
    if (tailBuffer < 0) tailBuffer = 0;
  }
  return {
    state: { capacity, tailBuffer, trackingTail: false },
    shouldScrollToTail: false,
  };
}

/**
 * onShrink — the filtered list shrank because the store was authoritatively
 * replaced (a 200 on reconnect resets the messages array). The old window
 * position is invalid, so reset to the initial state. (A verbose-toggle
 * shrink is NOT handled here — see onFilterChange, which ChatLog's
 * verboseLogs watcher applies explicitly so a filter change is never
 * confused with a genuine append/shrink.)
 */
export function onShrink(): CollapseState {
  return initialCollapseState();
}

/**
 * onFilterChange — the filtered set's MEMBERSHIP changed because the verbose
 * toggle flipped (详细日志 on/off), not because messages arrived or the store
 * was replaced. This is distinct from onAppend (genuine arrivals grow the
 * filtered list at the tail) and onShrink (a 200 replace authoritatively
 * resets the store): a verbose toggle can grow OR shrink the filtered list,
 * and the messages that enter/leave are interspersed throughout history, not
 * appended at the tail. Treating that as an append would wrongly mutate
 * capacity/tailBuffer; treating it as a shrink is closer but semantically
 * coincidental. The honest policy is: the old window position is no longer
 * meaningful (different messages are now visible), so reset to the initial
 * window and let the user re-expand if desired. Kept as a SEPARATE reducer
 * from onShrink so the two policies can diverge if a future verbose-toggle
 * UX wants to preserve capacity (e.g. keep x, just re-derive the window) —
 * the call site (ChatLog's verboseLogs watcher) picks this transition
 * explicitly, making the intent unambiguous.
 */
export function onFilterChange(): CollapseState {
  return initialCollapseState();
}

/** The kind of change a filtered-list observation represents.
 *
 *  `classifyChange` is the PURE decision the ChatLog watcher must make each
 *  time it observes a new (verboseLogs, filteredLength) pair, so the
 *  verbose-toggle-vs-append distinction is unit-testable instead of living
 *  only in watcher choreography. */
export type ChangeKind = 'filter' | 'append' | 'shrink' | 'none';

/** A single observation of the (verboseLogs, filteredLength) pair the
 *  ChatLog watcher tracks. `applyObservation` takes the PREVIOUS and
 *  CURRENT observation so the whole state transition — not just the
 *  classification — is a pure, unit-testable function (the watcher becomes
 *  a thin caller, which is what made the round-8 delta=0 / lazy-first-
 *  change bugs detectable in tests rather than only at runtime). */
export interface Observation {
  verbose: boolean;
  filteredLength: number;
}

/** The result of applying one observation: the new collapse state plus the
 *  one side-effect signal the pure reducer can compute (whether the caller
 *  should re-scroll to the tail). The DOM/scroll itself stays in the
 *  component — this is the pure part. */
export interface ObservationResult {
  state: CollapseState;
  shouldScrollToTail: boolean;
}

/**
 * classifyChange — decide which collapse transition applies given the
 * PREVIOUS and CURRENT (verboseLogs, filteredLength) observations.
 *
 *   verboseLogs changed  → 'filter'   (the visible set's membership changed;
 *                                      onFilterChange regardless of any
 *                                      length delta — a toggle that happens
 *                                      to leave length identical is STILL a
 *                                      filter change, NOT 'none', so the
 *                                      window resets and the NEXT real
 *                                      append is not swallowed by a stale
 *                                      guard flag)
 *   verboseLogs unchanged & grew      → 'append'   (genuine tail arrivals)
 *   verboseLogs unchanged & shrank    → 'shrink'   (200-replace store reset)
 *   verboseLogs unchanged & same      → 'none'     (content edit; leave the
 *                                      window alone)
 *
 * `prevVerbose === undefined` / `prevFilteredLength === undefined` signal
 * the FIRST observation (the watcher's initial run) — classify as 'none' so
 * the initial render keeps INITIAL_VISIBLE (mirrors the old `oldLen ===
 * undefined` early-return).
 *
 * This replaces the prior two-watcher + filterChangePending design, which
 * had two bugs: (1) a verbose toggle that left filteredLength identical
 * never fired the length watcher, so the flag stayed set and swallowed the
 * next real append; (2) checking trackingTail AFTER onFilterChange (which
 * forces trackingTail=true) made the re-scroll unconditional. Folding both
 * signals into one pure classifier removes the cross-watcher synchronization
 * entirely — there is no flag whose lifetime depends on another watcher
 * firing.
 */
export function classifyChange(
  prevVerbose: boolean | undefined,
  nextVerbose: boolean,
  prevFilteredLength: number | undefined,
  nextFilteredLength: number,
): ChangeKind {
  if (prevVerbose === undefined || prevFilteredLength === undefined) return 'none';
  if (prevVerbose !== nextVerbose) return 'filter';
  if (nextFilteredLength > prevFilteredLength) return 'append';
  if (nextFilteredLength < prevFilteredLength) return 'shrink';
  return 'none';
}

/**
 * applyObservation — the PURE state transition the ChatLog watcher runs each
 * time it observes a new (verboseLogs, filteredLength) pair. It classifies
 * the change (classifyChange) and dispatches to the right reducer, returning
 * the new collapse state + the shouldScrollToTail signal.
 *
 * This is the WHOLE watcher body as a pure function — extracted so the full
 * transition (not just the classifier) is unit-testable. The round-8 bugs
 * (#19 delta=0, #20 lazy-first-change) lived in the watcher's manual
 * prev-ref bookkeeping and passed the test suite because the tests only
 * covered classifyChange, not the transition that consumes it. With the
 * transition itself pure, those bugs are structural: the caller passes the
 * previous observation Vue supplies via the (newValue, oldValue) callback
 * signature, so there is no manual advancement to get wrong and no undefined-
 * prev first-run case (Vue evaluates the source at setup, so the first real
 * change gets a real prev observation).
 *
 *   'append'  → onAppend(state, next.filteredLength - prev.filteredLength).
 *               shouldScrollToTail = the reducer's signal (true when tracking
 *               and messages arrived, even at the capacity floor — #9).
 *   'shrink'  → onShrink() (reset; a 200 replace invalidated the window).
 *               No re-scroll signal (the caller re-derives position).
 *   'filter'  → onFilterChange() (reset; the visible set's membership
 *               changed). shouldScrollToTail = the user's PRE-toggle
 *               trackingTail (captured BEFORE onFilterChange forces it true
 *               — #16), so a user reading older history stays put.
 *   'none'    → unchanged state, no signal (content edit or initial run).
 *
 * `prev` may be undefined ONLY when the caller has no prior observation;
 * classifyChange then returns 'none' and the state is returned unchanged.
 * In practice the ChatLog watcher always has a real prev (Vue supplies it),
 * but the undefined guard keeps the function total.
 */
export function applyObservation(
  prev: Observation | undefined,
  next: Observation,
  state: CollapseState,
): ObservationResult {
  const kind = classifyChange(
    prev?.verbose,
    next.verbose,
    prev?.filteredLength,
    next.filteredLength,
  );
  if (kind === 'append') {
    // delta is computed from the PREVIOUS observation (passed in), not from a
    // manually-advanced ref — so a 10→11 append yields delta=1, not 0 (#19).
    const delta = next.filteredLength - (prev?.filteredLength ?? next.filteredLength);
    const r = onAppend(state, delta);
    return { state: r.state, shouldScrollToTail: r.shouldScrollToTail };
  }
  if (kind === 'shrink') {
    return { state: onShrink(), shouldScrollToTail: false };
  }
  if (kind === 'filter') {
    // Capture the user's tail position BEFORE onFilterChange resets
    // trackingTail=true (#16), so we only signal a re-scroll if they were
    // actually following the tail.
    const wasTrackingTail = state.trackingTail;
    return { state: onFilterChange(), shouldScrollToTail: wasTrackingTail };
  }
  // 'none' — content edit or initial run; leave the window.
  return { state, shouldScrollToTail: false };
}