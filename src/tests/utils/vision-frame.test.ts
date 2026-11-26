/**
 * vision-frame.test.ts - the bridge between the frame the model sees and the
 * pixels the file actually holds.
 *
 * The regression these lock: `imgDescribe` downscales anything wider than
 * 1920px, so on a 4K monitor the model was answering in a coordinate space
 * nobody else shared, and the original size was never stated at all.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  formatVisionFrameNote,
  formatVisionFramePrompt,
  frameScale,
  isResized,
  type VisionFrame
} from '../../utils/vision-frame.js';

const unchanged: VisionFrame = { originalWidth: 1280, originalHeight: 720, sentWidth: 1280, sentHeight: 720 };
const downscaled: VisionFrame = { originalWidth: 3840, originalHeight: 2160, sentWidth: 1920, sentHeight: 1080 };

describe('isResized / frameScale', () => {
  it('reports an unchanged frame as not resized with scale 1', () => {
    expect(isResized(unchanged)).toBe(false);
    expect(frameScale(unchanged)).toBe(1);
  });

  it('reports a downscaled frame with the ORIGINAL/SENT ratio', () => {
    expect(isResized(downscaled)).toBe(true);
    expect(frameScale(downscaled)).toBe(2);
  });

  it('treats a missing frame as not resized', () => {
    expect(isResized(undefined)).toBe(false);
  });

  it('never divides by a zero sent width', () => {
    expect(frameScale({ originalWidth: 1920, originalHeight: 1080, sentWidth: 0, sentHeight: 0 })).toBe(1);
  });
});

describe('formatVisionFramePrompt', () => {
  it('says the coordinates are already original when nothing was resized', () => {
    const prompt = formatVisionFramePrompt(unchanged);
    expect(prompt).toContain('1280×720');
    expect(prompt).toContain('original-image pixel coordinates');
  });

  it('states BOTH sizes, the scale, and asks for original coordinates after a downscale', () => {
    const prompt = formatVisionFramePrompt(downscaled);
    expect(prompt).toContain('3840×2160');
    expect(prompt).toContain('1920×1080');
    expect(prompt).toContain('×2');
    expect(prompt).toContain('ORIGINAL-image pixel coordinates');
    // The model must be warned the image in front of it is not full resolution,
    // otherwise it reports frame pixels and claims they are original.
    expect(prompt).toContain('NOT at full resolution');
  });

  it('renders a fractional scale without inventing precision', () => {
    const prompt = formatVisionFramePrompt({
      originalWidth: 2400,
      originalHeight: 1600,
      sentWidth: 1920,
      sentHeight: 1280
    });
    expect(prompt).toContain('×1.25');
  });

  it('tells the model to describe positions relatively when the size is unknown', () => {
    const prompt = formatVisionFramePrompt(undefined);
    expect(prompt).toContain('unknown');
    expect(prompt).toContain('relative');
    // Must not silently omit the block: silence invites the model to guess a size.
    expect(prompt.length).toBeGreaterThan(40);
  });

  it('does not claim a size when the frame carries no width', () => {
    const prompt = formatVisionFramePrompt({ originalWidth: 0, originalHeight: 0, sentWidth: 0, sentHeight: 0 });
    expect(prompt).toContain('unknown');
    expect(prompt).not.toContain('pixels, sent unscaled');
  });
});

describe('formatVisionFrameNote (agent-facing)', () => {
  it('is empty when no frame is known, so tool output is unchanged', () => {
    expect(formatVisionFrameNote(undefined)).toBe('');
  });

  it('renders a compact size label for an unchanged frame', () => {
    expect(formatVisionFrameNote(unchanged)).toBe('_[frame: 1280×720]_');
  });

  it('shows both frames and the scale for a downscaled one', () => {
    const note = formatVisionFrameNote(downscaled);
    expect(note).toContain('3840×2160 → 1920×1080 ×2');
    expect(note).toContain('coordinates above are in 3840×2160');
  });

  it('keeps a single underscore pair so markdown emphasis survives', () => {
    for (const frame of [unchanged, downscaled]) {
      const note = formatVisionFrameNote(frame);
      expect(note.startsWith('_[')).toBe(true);
      expect(note.endsWith(']_')).toBe(true);
      expect(note.slice(2, -2)).not.toContain('_');
    }
  });
});
