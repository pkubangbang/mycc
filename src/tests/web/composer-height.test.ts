/**
 * composer-height.test.ts — the composer band's drag arithmetic
 * (src/web/src/composer-height.ts).
 *
 * THE MODEL, and why it is this one.
 *
 * A resize handle is a grab: at pointerdown the band has height `h0` and the
 * pointer is at `y0`, so from then on ONE pointer position must mean ONE band
 * height —
 *
 *     height(y) = clamp(anchorHeight − (y − anchorY))
 *
 * The anchor never moves during the gesture. Consequences, and they are the
 * behaviour the live page shows:
 *
 *   • while the band is inside the bounds the handle and the pointer move
 *     together, so the grab offset stays exactly what it was at pointerdown;
 *   • while the band is pinned at a bound the pointer runs ahead, and the
 *     return trip re-enters the range at the same Y it left it — no dead zone,
 *     because there is no accumulated state to repay;
 *   • returning to a Y always returns to the same height (a drag is a cursor on
 *     a one-dimensional value, not a history of deltas).
 *
 * The alternative — re-basing the anchor at the bound so "the first pixel back
 * moves the band" — was implemented and measured on the live page, and it
 * freezes the offset at the OVER-DRAG value instead (−303px after a floor
 * over-drag): the handle can then never come back under the cursor. Two models,
 * one of them strictly better; this file pins the better one.
 *
 * Truth table (derived by hand, `node` probe, before any assertion was written):
 *
 *   floor   start 200 @ y=500 → 630:70  800:70  620:80  500:200  400:300
 *   ceiling start 200 @ y=900 → 780:320 200:320 790:310 800:300  900:200
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  COMPOSER_MIN_H,
  COMPOSER_MAX_H,
  clampComposerHeight,
  beginDrag,
  anchoredHeight
} from '../../web/src/composer-height.js';

/** pointerdown → pointermove…, exactly what ChatInput does. */
function gesture(startY: number, startHeight: number) {
  const anchor = beginDrag(startY, startHeight);
  return { anchor, move: (y: number): number => anchoredHeight(anchor, y) };
}

describe('clampComposerHeight — the declared bounds, in one place', () => {
  it('keeps a value inside the bounds untouched', () => {
    expect(clampComposerHeight(200)).toBe(200);
    expect(clampComposerHeight(COMPOSER_MIN_H)).toBe(COMPOSER_MIN_H);
    expect(clampComposerHeight(COMPOSER_MAX_H)).toBe(COMPOSER_MAX_H);
  });

  it('clamps both ends and falls back to the floor for a non-finite value', () => {
    expect(clampComposerHeight(10_000)).toBe(COMPOSER_MAX_H);
    expect(clampComposerHeight(-50)).toBe(COMPOSER_MIN_H);
    expect(clampComposerHeight(Number.NaN)).toBe(COMPOSER_MIN_H);
  });
});

describe('free band — follows the pointer 1:1', () => {
  it('grows when the pointer moves up and shrinks when it moves down', () => {
    const g = gesture(500, 200);
    expect(g.move(480)).toBe(220);
    expect(g.move(520)).toBe(180);
    expect(g.move(500)).toBe(200);
  });
});

describe('floor — the (m − 80)px report', () => {
  it('pins at the floor however far the pointer goes', () => {
    const g = gesture(500, 200);
    expect(g.move(630)).toBe(COMPOSER_MIN_H);
    expect(g.move(800)).toBe(COMPOSER_MIN_H);
  });

  it('re-enters at the same Y it left — no dead zone, no offset gained', () => {
    const g = gesture(500, 200);
    g.move(800); // far past the floor
    expect(g.move(620)).toBe(COMPOSER_MIN_H + 10); // y=620 is 10px above the pin point
    expect(g.move(500)).toBe(200); // the gesture's own start
    expect(g.move(400)).toBe(300);
  });

  it('one pointer Y always means one height', () => {
    const g = gesture(500, 200);
    g.move(800);
    const a = g.move(600);
    g.move(900);
    expect(g.move(600)).toBe(a);
  });
});

describe('ceiling — the 800px drag then back down', () => {
  it('pins at the ceiling however far the pointer goes', () => {
    const g = gesture(900, 200);
    expect(g.move(780)).toBe(COMPOSER_MAX_H);
    expect(g.move(200)).toBe(COMPOSER_MAX_H);
  });

  it('re-enters where it left, and reaches 300px on the way back', () => {
    const g = gesture(900, 200);
    g.move(200); // far past the ceiling
    expect(g.move(790)).toBe(COMPOSER_MAX_H - 10);
    expect(g.move(800)).toBe(300); // 20px below the ceiling's pin point (780)
    expect(g.move(900)).toBe(200); // back to the start
  });

  it('one pointer Y always means one height', () => {
    const g = gesture(900, 200);
    g.move(200);
    const a = g.move(850);
    g.move(300);
    expect(g.move(850)).toBe(a);
  });
});

describe('the whole gesture is a pure function of the anchor', () => {
  it('a zig-zag through both bounds always returns to the same height', () => {
    const g = gesture(500, 200);
    for (let y = 500; y <= 1200; y += 50) g.move(y);
    for (let y = 1150; y >= -300; y -= 50) g.move(y);
    for (let y = -250; y <= 500; y += 50) g.move(y);
    expect(g.move(500)).toBe(200);
    expect(g.move(490)).toBe(210);
  });
});
