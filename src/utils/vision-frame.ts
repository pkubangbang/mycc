/**
 * vision-frame.ts - tell the vision model what resolution it is looking at
 *
 * `CoreModule.imgDescribe` downscales any image wider than 1920px before the
 * vision call (src/context/parent/core.ts, `resizeImageIfNeeded`). That keeps
 * the payload small, but it silently moves the model into a different
 * coordinate space: a 3840x2160 monitor reaches the model as 1920x1080, so a
 * model answering "the button is at (960, 540)" is speaking in FRAME
 * coordinates while every other piece of evidence the agent holds (an
 * accessibility tree, a click target, a device-pixel-ratio) is in ORIGINAL
 * coordinates. Nothing bridged the two, so coordinate deduction broke exactly
 * on the displays where it matters most.
 *
 * This module owns the bridge: a block appended to the vision prompt stating
 * the original frame size and telling the model to report positions as
 * ORIGINAL-image pixels. It is attached inside `imgDescribe`, so EVERY caller
 * inherits it — `screen`, and both `read_picture` paths (cache miss and the
 * new-focus merge) — with no per-tool opt-in.
 *
 * Deliberately pure and fs-free: the caller measures the image (sharp metadata
 * is already read for the resize decision) and passes the numbers in.
 */

/**
 * The width cap `imgDescribe` downscales to before the vision call.
 *
 * Exported because a second consumer needs the SAME geometry: the screen diff
 * (src/utils/screen-diff.ts) caps its difference image — never its ratio, which
 * is measured at native resolution — to this width, so the pixels it highlights
 * line up with the frame the model actually sees. Two inline copies of 1920
 * would drift apart the day one of them is tuned.
 */
export const VISION_MAX_WIDTH = 1920;

/** The geometry of one vision call: what was measured, and what was sent. */
export interface VisionFrame {
  /** Width of the image as stored on disk / handed to the tool. */
  originalWidth: number;
  /** Height of the image as stored on disk / handed to the tool. */
  originalHeight: number;
  /** Width actually sent to the vision model (may equal originalWidth). */
  sentWidth: number;
  /** Height actually sent to the vision model (may equal originalHeight). */
  sentHeight: number;
}

/**
 * True when the bytes handed to the model are NOT the original geometry, i.e.
 * any coordinate the model reports needs scaling back.
 */
export function isResized(frame: VisionFrame | undefined): boolean {
  if (!frame) return false;
  return frame.sentWidth !== frame.originalWidth || frame.sentHeight !== frame.originalHeight;
}

/**
 * Horizontal scale ORIGINAL/SENT (e.g. 2 for a 3840px monitor sent at 1920).
 * Returns 1 when nothing was resized or the numbers are unusable.
 *
 * The resize is width-locked (`sharp().resize(maxWidth)` in core.ts), so the
 * vertical scale is the same factor; it is still computed from the heights so a
 * future cover/contain fit that changes the aspect ratio does not silently
 * report a wrong scale.
 */
export function frameScale(frame: VisionFrame): number {
  if (!isResized(frame) || frame.sentWidth <= 0) return 1;
  return frame.originalWidth / frame.sentWidth;
}

/** `3840×2160`, or '' when the dimensions are unknown. */
function sizeLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '';
  return `${width}×${height}`;
}

/**
 * The prompt appended to every vision call.
 *
 * Shape rules that matter:
 *  - EMPTY STRING when nothing was resized: the common case (a normal screen,
 *    a small photo) must keep today's prompt byte-identical, so this cannot
 *    quietly change how an unchanged image is described.
 *  - Even when nothing was resized the original size is still stated, because
 *    "how big is this image" is a question an image alone cannot answer: the
 *    model only ever sees pixels, never their count. That is the whole reason
 *    coordinate deduction failed.
 *  - Phrased as a direct instruction in the second person, because the model
 *    receives it as the trailing part of its instruction — not as metadata it
 *    has to remember to consult.
 *
 * @param frame - geometry of this call, or undefined when the caller could not
 *   measure the image (e.g. an undecodable format)
 */
export function formatVisionFramePrompt(frame: VisionFrame | undefined): string {
  const original = frame ? sizeLabel(frame.originalWidth, frame.originalHeight) : '';
  if (!frame || !original) {
    // Dimensions unknown: say so explicitly instead of staying silent. A model
    // told nothing tends to volunteer its own "the image is about N pixels"
    // guess, which the agent then has to unlearn.
    return (
      '\n\n[Image frame: the pixel dimensions of this image are unknown. ' +
      'Describe positions relative to what you see (e.g. "top-left area", "the second row") ' +
      'rather than inventing pixel coordinates.]'
    );
  }

  if (!isResized(frame)) {
    return (
      `\n\n[Image frame: ${original} pixels, sent unscaled — the coordinates you read ARE original-image pixels. ` +
      'Report any position, size or bounding box in original-image pixel coordinates.]'
    );
  }

  const sent = sizeLabel(frame.sentWidth, frame.sentHeight);
  const scale = frameScale(frame);
  const scaleText = Number.isFinite(scale) ? `×${scale.toFixed(scale % 1 === 0 ? 0 : 3)}` : 'unknown';
  return (
    `\n\n[Image frame: originally ${original} pixels, downscaled to ${sent} for this request (scale ${scaleText}). ` +
    'The image you are looking at is NOT at full resolution. ' +
    `Report every position, size and bounding box in ORIGINAL-image pixel coordinates — ` +
    `multiply what you measure by the scale — in the ${original} frame. ` +
    'If you cannot convert reliably, say the coordinates are approximate rather than mixing the two frames.]'
  );
}

/**
 * The same information, rendered for the AGENT (the tool result), not the
 * model: a compact suffix the tool can attach so the numbers survive even when
 * the model ignores the instruction above.
 */
export function formatVisionFrameNote(frame: VisionFrame | undefined): string {
  const original = frame ? sizeLabel(frame.originalWidth, frame.originalHeight) : '';
  if (!frame || !original) return '';
  if (!isResized(frame)) return `_[frame: ${original}]_`;
  const scale = frameScale(frame);
  const scaleText = Number.isFinite(scale) ? `×${scale.toFixed(scale % 1 === 0 ? 0 : 3)}` : '×?';
  return `_[frame: ${original} → ${sizeLabel(frame.sentWidth, frame.sentHeight)} ${scaleText}; coordinates above are in ${original}]_`;
}
