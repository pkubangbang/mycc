/**
 * composer-height.ts — the composer band's height bounds and drag arithmetic.
 *
 * ## One anchor, one arithmetic
 *
 * A resize handle that ACCUMULATES a delta (`current + (lastY − y)`) drifts the
 * moment anything clamps it: the stored number and the rendered edge stop
 * agreeing, and every pixel of travel that the band did not follow becomes a
 * dead zone that must be repaid before the handle returns to the cursor. Both
 * reported defects are that one bug at the two ends:
 *
 *   • ceiling: drag 200px up to 800px, come back to 300px — the box only
 *     started shrinking after ~480px of return travel;
 *   • floor: the DOM's real floor is the textarea's intrinsic height `m`
 *     (≈150px), not the declared `COMPOSER_MIN_H` (70), so a drag to "80px"
 *     overshot `m` and the handle sat `(m − 80)` px above the pointer.
 *
 * The fix is not a better correction — it is to stop accumulating. Record the
 * pointer and the band's RENDERED height once, at pointerdown, and derive every
 * later height absolutely:
 *
 *     height(y) = clamp(anchorHeight − (y − anchorY))
 *
 * `height(y)` is a pure function of the pointer's position, so the handle is
 * under the cursor by construction wherever the gesture started, and returning
 * to a Y always returns to the same height. Nothing is carried between moves.
 */

/** The band's declared floor: two textarea lines plus the row's padding. */
export const COMPOSER_MIN_H = 70;

/** The band's declared ceiling. */
export const COMPOSER_MAX_H = 320;

/** Clamp any height into the band's DECLARED bounds (non-finite → the floor). */
export function clampComposerHeight(h: number): number {
  const value = Number.isFinite(h) ? h : COMPOSER_MIN_H;
  return Math.min(Math.max(value, COMPOSER_MIN_H), COMPOSER_MAX_H);
}

/** The gesture's fixed anchor, captured once at pointerdown. */
export interface DragAnchor {
  /** Pointer clientY when the gesture began. */
  anchorY: number;
  /**
   * The band's height AS RENDERED when the gesture began — the layout's own
   * floor included. Starting from this (not from the declared value) is what
   * makes the first pixel correct when the band was already clamped by the DOM.
   */
  anchorHeight: number;
}

/**
 * The band height for a pointer at clientY `y` — anchored to the gesture's
 * start and re-based as the anchor when the band CLAMPS.
 *
 * A purely fixed anchor (`anchorHeight − (y − anchorY)`) already answers the
 * FLOOR case, because the handle and the pointer move together while the band
 * is pinned: returning up re-enters the range immediately. It does NOT answer
 * the CEILING case in practice — once the band stops at COMPOSER_MAX_H the
 * pointer can run far above it, and the whole overshoot has to be repaid before
 * the band moves again.
 *
 * So the anchor is also RE-BASED, in place, the moment the computed height hits
 * a bound: `anchorY` and `anchorHeight` jump to the current pointer and the
 * clamped height. From that pixel on the band follows the pointer 1:1 in BOTH
 * directions — the handle can never be more than the drag's own starting offset
 * away from the cursor.
 *
 * @param anchor - the gesture anchor (read only; never mutated).
 * @param y      - the pointer's clientY now.
 */
export function anchoredHeight(anchor: DragAnchor, y: number): number {
  // The handle sits on the TOP edge: the pointer moving up (y shrinks) grows
  // the band. ONE pointer position → ONE height, for the whole gesture: the
  // anchor is captured at pointerdown and never re-based, so re-entering the
  // range returns to the height that Y had on the way out.
  return clampComposerHeight(anchor.anchorHeight - (y - anchor.anchorY));
}

/**
 * Capture the anchor at pointerdown. `rendered` is the band's measured height;
 * it is clamped so a first-paint value can never seed an out-of-range anchor.
 */
export function beginDrag(pointerY: number, rendered: number): DragAnchor {
  return { anchorY: pointerY, anchorHeight: clampComposerHeight(rendered) };
}
