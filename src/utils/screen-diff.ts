/**
 * screen-diff.ts - keep the previous screen frame and diff the next one against it
 *
 * Feeds a SECOND image to the vision model when the current screen is close to
 * the previous one. A mostly-static screen is the normal case, and on such a
 * screen "what changed since last time" is the question the model cannot answer
 * from the current frame alone — the model sees one moment, not a sequence.
 *
 * Two decisions worth stating up front:
 *
 * 1. The baseline is OWNED BYTES, never a borrowed path. `screen` captures to a
 *    per-call temp file (`mycc_screen_<ts>.png`) and unlinks it in `finally`, so
 *    holding the path would be a use-after-delete. The captured PNG is read into
 *    a Buffer inside the call, and that Buffer is what is retained. Overwrite
 *    and deletion are then irrelevant by construction.
 *
 * 2. "Fresh" means THIS PROCESS. The slot is module state, which is exactly the
 *    session scope: `screenTool` is a static built-in (registry.ts) and built-ins
 *    are not hot-reloadable (docs/tools/dynamic-loading.md), so the module lives
 *    as long as the run. A restart legitimately starts fresh.
 *
 * Deliberately fs-free: the caller reads the PNG, this module only measures.
 */

import sharp from 'sharp';
import { VISION_MAX_WIDTH } from './vision-frame.js';

/** A baseline older than this is not "fresh" and is not diffed against. */
export const SCREEN_BASELINE_TTL_MS = 15 * 60 * 1000;

/**
 * The diff path fires when at least this fraction of pixels is IDENTICAL
 * between the two frames. The literal reading of the requirement: a mostly
 * unchanged screen is when a difference image is informative — a screen whose
 * pixels changed beyond recognition would make the diff noise.
 */
export const DIFF_IDENTICAL_MIN_RATIO = 0.15;

/**
 * Amplifies the `difference` composite so a small delta reads as bright rather
 * than as a barely-visible dark grey. The unchanged pixels stay exactly black.
 */
const DIFF_AMPLIFY = 2.5;

/** One retained screen frame. `monitor` is the caller's 1-based desktop number. */
export interface ScreenBaseline {
  png: Buffer;
  monitor: number;
  takenAt: number;
}

export interface PairDiff {
  /** Fraction of pixels whose RGB triplet is exactly equal, in [0, 1]. */
  identicalRatio: number;
  /** PNG of the per-pixel absolute difference (bright = changed, black = same). */
  diffPng: Buffer;
}

/** The single retained slot. One screen baseline is enough: only the last frame matters. */
let baseline: ScreenBaseline | null = null;

/**
 * The retained baseline for `monitor`, or null when there is none, it is older
 * than {@link SCREEN_BASELINE_TTL_MS}, or it belongs to another monitor (a
 * per-monitor diff against a different monitor's frame is meaningless).
 */
export function getScreenBaseline(monitor: number, now: number = Date.now()): ScreenBaseline | null {
  if (!baseline) return null;
  if (baseline.monitor !== monitor) return null;
  if (now - baseline.takenAt > SCREEN_BASELINE_TTL_MS) return null;
  return baseline;
}

/** Replace the retained baseline with the frame just captured. */
export function setScreenBaseline(next: ScreenBaseline): void {
  baseline = next;
}

/**
 * Drop the retained baseline. Exported for tests so each case starts cold;
 * production never needs it (the TTL and the process lifetime bound the slot).
 */
export function resetScreenBaselineForTests(): void {
  baseline = null;
}

/**
 * Compare two frames: how many pixels are identical, and where they differ.
 *
 * ORDER IS THE POINT: the diff is computed at NATIVE resolution, before any
 * resize. Resampling blurs a one-pixel change into a few grey pixels, which
 * both hides small edits and makes "identical" depend on the resampler rather
 * than on the screen. So:
 *
 * 1. the two frames are decoded at their own size and the ratio is counted
 *    there — that number answers "did the screen change", not "did two
 *    differently-resampled images agree";
 * 2. only when the geometry differs (a window was moved to a smaller monitor,
 *    resolution changed) is the baseline resized, with `fit: 'fill'` so the
 *    byte count matches the composite's declared geometry exactly;
 * 3. the RESULTING diff image is capped at {@link VISION_MAX_WIDTH} so it is
 *    the same size as the frame the vision model receives — the diff is only
 *    ever consumed as that second image, and a coordinate the model points at
 *    must map onto it.
 */
export async function computePairDiff(before: ScreenBaseline, afterPng: Buffer): Promise<PairDiff> {
  const [afterMeta, beforeMeta] = await Promise.all([sharp(afterPng).metadata(), sharp(before.png).metadata()]);
  const afterWidth = afterMeta.width ?? 0;
  const afterHeight = afterMeta.height ?? 0;
  const beforeWidth = beforeMeta.width ?? 0;
  const beforeHeight = beforeMeta.height ?? 0;
  if (!afterWidth || !afterHeight) {
    throw new Error('Cannot diff: the new frame has no measurable geometry');
  }
  if (!beforeWidth || !beforeHeight) {
    throw new Error('Cannot diff: the baseline has no measurable geometry');
  }

  // Step 1+2: decode at native size; resize ONLY on a geometry mismatch, so the
  // common same-resolution case never resamples a pixel that did not change.
  const after = await rawRgb(afterPng, afterWidth, afterHeight, false);
  const sameGeometry = beforeWidth === afterWidth && beforeHeight === afterHeight;
  const beforeRaw = sameGeometry
    ? await rawRgb(before.png, beforeWidth, beforeHeight, false)
    : await rawRgb(before.png, afterWidth, afterHeight, true);
  if (beforeRaw.length !== after.length) {
    throw new Error(`Cannot diff: frame sizes disagree after decode (${after.length} vs ${beforeRaw.length} bytes)`);
  }

  // Count from the actual buffers so a future channels change cannot silently
  // miscount.
  const pixelCount = after.length / 3;
  if (pixelCount <= 0) {
    throw new Error('Cannot diff: decoded frames are empty');
  }

  let identical = 0;
  for (let i = 0; i < pixelCount * 3; i += 3) {
    if (after[i] === beforeRaw[i] && after[i + 1] === beforeRaw[i + 1] && after[i + 2] === beforeRaw[i + 2]) {
      identical++;
    }
  }

  // Diff on raw RGB bytes at native size, then wrap them in a PNG container
  // directly.
  //
  // Every sharp step here is done on 3-channel raw data and the only encode is
  // the final `toFormat('png')`: letting sharp encode an intermediate result
  // re-inserts an alpha channel (transparent wherever the difference is zero),
  // which a vision model receives as a blank image.
  const diffRgb = await sharp(after, { raw: { width: afterWidth, height: afterHeight, channels: 3 } })
    .composite([
      {
        input: beforeRaw,
        raw: { width: afterWidth, height: afterHeight, channels: 3 },
        blend: 'difference'
      }
    ])
    .linear(DIFF_AMPLIFY)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();

  // Step 3: cap the diff image (never the ratio) to the vision call's width.
  const diffWidth = Math.min(VISION_MAX_WIDTH, afterWidth);
  const diffHeight = Math.max(1, Math.round((afterHeight * diffWidth) / afterWidth));
  const diffPng = await sharp(diffRgb, { raw: { width: afterWidth, height: afterHeight, channels: 3 } })
    .resize(diffWidth, diffHeight, { fit: 'fill' })
    .toFormat('png', { compressionLevel: 6 })
    .toBuffer();

  return { identicalRatio: identical / pixelCount, diffPng };
}

/**
 * Decode `input` to 3-channel sRGB raw at the target geometry.
 *
 * `resize` is opt-in and only true on the geometry-mismatch path: decoding at
 * native size keeps the ratio a true pixel comparison, and a matching frame
 * must not be resampled (see computePairDiff for the ordering rationale).
 */
async function rawRgb(input: Buffer, width: number, height: number, resize: boolean): Promise<Buffer> {
  let pipeline = sharp(input);
  // `fit: 'fill'` forces EXACTLY width x height. A plain `resize(w, h)` would
  // preserve aspect ratio and could return fewer bytes than requested, which
  // the `difference` composite then rejects ("memory area too small").
  if (resize) pipeline = pipeline.resize(width, height, { fit: 'fill' });
  const { data } = await pipeline.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return data;
}
