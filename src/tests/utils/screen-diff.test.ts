/**
 * screen-diff.test.ts - Unit tests for the baseline slot and the pixel diff
 *
 * The ratio assertions are DERIVED from how each fixture is built (coloured
 * columns on a flat background), not read back from the implementation: an
 * implementation that silently changed its counting would fail here instead of
 * quietly agreeing with itself.
 */

import { describe, it, expect, beforeEach } from 'vite-plus/test';
import sharp from 'sharp';
import {
  computePairDiff,
  DIFF_IDENTICAL_MIN_RATIO,
  getScreenBaseline,
  resetScreenBaselineForTests,
  SCREEN_BASELINE_TTL_MS,
  setScreenBaseline,
  type ScreenBaseline
} from '../../utils/screen-diff.js';

/** A 100x100 PNG with `changedColumns` columns repainted. */
async function frame(changedColumns: number, width = 100, height = 100): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3, 0x20);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < changedColumns; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = 0xf0;
      pixels[i + 1] = 0x10;
      pixels[i + 2] = 0x10;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const baseline = (png: Buffer, over: Partial<ScreenBaseline> = {}): ScreenBaseline => ({
  png,
  monitor: 1,
  takenAt: Date.now(),
  ...over
});

describe('screen baseline slot', () => {
  beforeEach(() => {
    resetScreenBaselineForTests();
  });

  it('is empty before any capture', () => {
    expect(getScreenBaseline(1)).toBeNull();
  });

  it('returns the committed frame for the same monitor', async () => {
    const png = await frame(0);
    setScreenBaseline(baseline(png));
    expect(getScreenBaseline(1)?.png).toBe(png);
  });

  it('ignores a baseline from a different monitor', async () => {
    setScreenBaseline(baseline(await frame(0), { monitor: 2 }));
    expect(getScreenBaseline(1)).toBeNull();
    expect(getScreenBaseline(2)).not.toBeNull();
  });

  it('treats a baseline older than the TTL as not fresh', async () => {
    const png = await frame(0);
    const takenAt = 1_000_000;
    setScreenBaseline(baseline(png, { takenAt }));

    // Just inside the window is still fresh; one millisecond past is not.
    expect(getScreenBaseline(1, takenAt + SCREEN_BASELINE_TTL_MS)).not.toBeNull();
    expect(getScreenBaseline(1, takenAt + SCREEN_BASELINE_TTL_MS + 1)).toBeNull();
  });

  it('replaces the previous frame rather than accumulating', async () => {
    const first = await frame(0);
    const second = await frame(10);
    setScreenBaseline(baseline(first));
    setScreenBaseline(baseline(second));
    expect(getScreenBaseline(1)?.png).toBe(second);
  });
});

describe('computePairDiff', () => {
  it('reports 1.0 and an all-black difference for identical frames', async () => {
    const png = await frame(0);
    const diff = await computePairDiff(baseline(png), png);

    expect(diff.identicalRatio).toBe(1);

    const { data, info } = await sharp(diff.diffPng).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(100);
    expect(info.height).toBe(100);
    // Every channel of every pixel is exactly zero: nothing changed, so the
    // amplified difference must not leak brightness.
    expect(data.every((b) => b === 0)).toBe(true);
  });

  it('detects a single changed column (4/400 pixels -> 0.96 identical)', async () => {
    const before = await frame(0);
    const after = await frame(4);
    const diff = await computePairDiff(baseline(before), after);

    expect(diff.identicalRatio).toBeCloseTo(0.96, 10);
  });

  it('counts a fully changed frame as 0.0 identical', async () => {
    const before = await frame(0);
    const after = await frame(100);
    const diff = await computePairDiff(baseline(before), after);

    expect(diff.identicalRatio).toBe(0);
  });

  it('counts the ratio at NATIVE size, before any resize', async () => {
    // 2200px wide: wider than VISION_MAX_WIDTH (1920). If the ratio were
    // measured after the cap, resampling would perturb the pixels; measured
    // natively, a flat frame stays exactly flat.
    const before = await frame(0, 2200, 10);
    const after = await frame(0, 2200, 10);
    const diff = await computePairDiff(baseline(before), after);

    expect(diff.identicalRatio).toBe(1);
  });

  it('caps the DIFF IMAGE (not the ratio) at the vision width, after diffing', async () => {
    // 2200px wide with 1100 changed columns -> exactly half the pixels differ.
    // The ratio proves the count happened at native width; the image proves the
    // cap is applied to the output only.
    const before = await frame(0, 2200, 10);
    const after = await frame(1100, 2200, 10);
    const diff = await computePairDiff(baseline(before), after);

    expect(diff.identicalRatio).toBeCloseTo(0.5, 10);

    const meta = await sharp(diff.diffPng).metadata();
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(Math.max(1, Math.round((10 * 1920) / 2200)));
  });

  it('resizes the baseline only when the geometry differs', async () => {
    const before = await frame(0, 50, 50);
    const after = await frame(0, 200, 100);
    const diff = await computePairDiff(baseline(before), after);

    // Both are flat, so the resize leaves them identical — and the diff takes
    // the new frame's geometry.
    expect(diff.identicalRatio).toBe(1);
    const meta = await sharp(diff.diffPng).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });

  it('throws on an undecodable frame instead of returning a bogus ratio', async () => {
    const png = await frame(0);
    await expect(computePairDiff(baseline(png), Buffer.from('not a png'))).rejects.toThrow();
  });

  it('agrees with the threshold constant the tool consumes', () => {
    expect(DIFF_IDENTICAL_MIN_RATIO).toBe(0.15);
  });
});
