/**
 * wrap-up-state.ts - neutral, framework-free wrap-up state singleton
 *
 * Owns the background ESC wrap-up lifecycle state that used to live inline in
 * esc-wrap-up.ts (the `wrapUpState` module singleton + its accessors). The
 * extraction serves two purposes:
 *
 * 1. Facet separation (review gate A5): the wrap-up STATE module holds no
 *    queue logic and no LLM orchestration — it is pure state + pure policy.
 *    esc-wrap-up.ts keeps the LLM orchestration (runWrapUpLLM/startWrapUp/
 *    display paths).
 * 2. Import-cycle avoidance: ServeHub pulls `isWrapUpInFlight()` from here
 *    (serve → loop direction, allowed) instead of importing esc-wrap-up, which
 *    would close the cycle esc-wrap-up → serve-registry → serve-hub →
 *    esc-wrap-up. No callback registration is involved — the hub PULLS the
 *    boolean on every delivery check.
 *
 * The steering manager (src/loop/steering-manager.ts) never imports this
 * module: `takeForDelivery(isParked, wrapUpInFlight)` takes the wrap-up
 * liveness as a plain boolean so the two facets stay decoupled (A5).
 */

import type { Triologue } from './triologue.js';

/**
 * WrapUpState - Tracks the state of background wrap-up after ESC
 */
export interface WrapUpState {
  /** Promise that resolves when wrap-up LLM call completes */
  promise: Promise<string> | null;
  /** Content from the wrap-up response (set when complete) */
  content: string | null;
  /** Timestamp when wrap-up completed (ms since epoch) */
  completedAt: number | null;
  /** Whether the wrap-up content has been shown to user */
  shown: boolean;
  /** The triologue to inject messages into when wrap-up completes */
  triologue: Triologue | null;
}

/**
 * Grace period for wrap-up append (ms)
 * If user submits within this time after wrap-up shows, wrap-up is discarded
 */
export const WRAP_UP_GRACE_PERIOD_MS = 3000;

// Singleton wrap-up state
let wrapUpState: WrapUpState = {
  promise: null,
  content: null,
  completedAt: null,
  shown: false,
  triologue: null,
};

/**
 * Whether a background wrap-up LLM call is currently in flight.
 * ServeHub reads this (pull) at every park-time delivery check so steering
 * notes arriving during the wrap-up window are HELD instead of submitted
 * (evaluation→rollback truncation hazard — docs/steering-manager-plan.md §3).
 */
export function isWrapUpInFlight(): boolean {
  return wrapUpState.promise !== null;
}

/**
 * Get current wrap-up state
 */
export function getWrapUpState(): WrapUpState {
  return wrapUpState;
}

/**
 * Check if wrap-up has completed and not yet shown
 */
export function hasPendingWrapUp(): boolean {
  return wrapUpState.content !== null && wrapUpState.content !== '' && !wrapUpState.shown;
}

/**
 * Mark wrap-up as shown
 */
export function markWrapUpShown(): void {
  wrapUpState.shown = true;
}

/**
 * Clear wrap-up state (discard without showing)
 */
export function clearWrapUp(): void {
  wrapUpState = {
    promise: null,
    content: null,
    completedAt: null,
    shown: false,
    triologue: null,
  };
}

/**
 * Attach a fresh in-flight wrap-up turn — the semantic capsule setter used by
 * esc-wrap-up's startWrapUp(). Object replacement (not field mutation) keeps
 * the single-owner semantics the module always had: any .then stale-guard
 * re-reads the capsule and sees a different promise object.
 */
export function beginWrapUpState(promise: Promise<string>, triologue: Triologue): void {
  wrapUpState = {
    promise,
    content: null,
    completedAt: null,
    shown: false,
    triologue,
  };
}

/**
 * Settle an in-flight wrap-up turn: run the stale-guard (a newer
 * startWrapUp() may have replaced the capsule), then record the content and
 * completion timestamp and NULL the promise — nulling is what marks the
 * wrap-up window as settled for isWrapUpInFlight() ("promise settle marks
 * settled", review gate A1) without an extra marker field. This is also what
 * lets the hub's wake seam deliver held notes right after the wrap-up LLM
 * finishes instead of waiting for the next clearWrapUp().
 *
 * @returns true when the settle applied (this promise was the live one).
 */
export function settleWrapUp(promise: Promise<string>, content: string): boolean {
  if (wrapUpState.promise !== promise) return false;
  wrapUpState.content = content;
  wrapUpState.completedAt = Date.now();
  wrapUpState.promise = null;
  return true;
}

/**
 * Check if the wrap-up is ready (completed with content) and past the grace period.
 * If yes, returns 'commit' — caller should call commitWrapUp() on the triologue.
 * If no, returns 'rollback' — caller should call rollbackWrapUp() on the triologue.
 * Note: After calling commitWrapUp() or rollbackWrapUp(), caller should also
 * call clearWrapUp() to reset the wrap-up state.
 */
export function evaluateWrapUp(): 'commit' | 'rollback' {
  const { completedAt, shown, content } = wrapUpState;

  // No wrap-up content, empty (failed), or already shown - rollback
  if (!content || shown) {
    return 'rollback';
  }

  // Wrap-up not yet completed - rollback (user submitted before wrap-up)
  if (completedAt === null) {
    return 'rollback';
  }

  // Check if within grace period (3s after wrap-up shows)
  const now = Date.now();
  const timeSinceCompletion = now - completedAt;

  // If more than 3s since completion, commit the wrap-up
  if (timeSinceCompletion >= WRAP_UP_GRACE_PERIOD_MS) {
    return 'commit';
  }

  // Within grace period - rollback
  return 'rollback';
}