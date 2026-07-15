/**
 * streaming-crossroad-detector.test.ts - Unit tests for StreamingCrossroadDetector
 *
 * Tests:
 * - Encoder detects turn when P > threshold
 * - No detection when P < threshold
 * - Fallback behavior when encoder is null
 * - Pending inference handled correctly in finalize()
 * - Multiple chunks accumulated properly
 */

import { describe, test, expect } from 'vitest';
import { StreamingCrossroadDetector } from '../../loop/streaming-crossroad-detector.js';
import type { CrossroadEncoder } from '../../loop/crossroad-encoder.js';

// ============================================================================
// Mock Encoder Factory
// ============================================================================

/**
 * Create a mock encoder with configurable predict() return value.
 * The mock allows controlling when the prediction resolves (via a delay)
 * and what probability it returns.
 */
function createMockEncoder(
  prob: number,
  threshold: number = 0.5,
  checkInterval: number = 10,
  delayMs: number = 0,
): CrossroadEncoder {
  return {
    predict: async (_text: string): Promise<number> => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      return prob;
    },
    getConfig: () => ({
      version: 1,
      baseModel: 'distilbert-base-uncased',
      maxSequenceLength: 512,
      threshold,
      checkInterval,
      trainedAt: '2026-07-14T00:00:00Z',
      trainingSamples: 1000,
    }),
  } as unknown as CrossroadEncoder;
}

// ============================================================================
// Tests
// ============================================================================

describe('StreamingCrossroadDetector', () => {
  test('encoder detects turn when P > threshold', async () => {
    const encoder = createMockEncoder(0.9, 0.5, 10);
    const detector = new StreamingCrossroadDetector(encoder, {});

    // Feed chunks until checkInterval is reached
    detector.onChunk('Hello world.'); // 12 chars >= 10
    const result = await detector.finalize();

    expect(result.detected).toBe(true);
    expect(result.turnIndex).toBe(12);
    expect(result.fullText).toBe('Hello world.');
  });

  test('no detection when P < threshold', async () => {
    const encoder = createMockEncoder(0.2, 0.5, 10);
    const detector = new StreamingCrossroadDetector(encoder, {});

    detector.onChunk('Hello world.'); // 12 chars >= 10
    const result = await detector.finalize();

    expect(result.detected).toBe(false);
    expect(result.turnIndex).toBe(-1);
    expect(result.fullText).toBe('Hello world.');
  });

  test('fallback behavior when encoder is null', async () => {
    const detector = new StreamingCrossroadDetector(null, {});

    // Feed multiple chunks — should accumulate without inference
    detector.onChunk('First chunk. ');
    detector.onChunk('Second chunk. ');
    detector.onChunk('Third chunk.');

    const result = await detector.finalize();

    expect(result.detected).toBe(false);
    expect(result.turnIndex).toBe(-1);
    expect(result.fullText).toBe('First chunk. Second chunk. Third chunk.');
  });

  test('pending inference handled correctly in finalize()', async () => {
    // Use a delay so inference is still pending when finalize() is called
    const encoder = createMockEncoder(0.9, 0.5, 10, 50);
    const detector = new StreamingCrossroadDetector(encoder, {});

    detector.onChunk('Hello world.'); // triggers inference (pending)
    // Don't wait — immediately call finalize() which should await the pending inference
    const result = await detector.finalize();

    expect(result.detected).toBe(true);
    expect(result.turnIndex).toBe(12);
  });

  test('multiple chunks accumulated properly', async () => {
    const encoder = createMockEncoder(0.2, 0.5, 100);
    const detector = new StreamingCrossroadDetector(encoder, {});

    // Feed small chunks that individually don't reach checkInterval
    detector.onChunk('chunk1 ');
    detector.onChunk('chunk2 ');
    detector.onChunk('chunk3 ');
    detector.onChunk('chunk4 ');
    detector.onChunk('chunk5 ');

    // Total = 40 chars, still < 100 so no inference triggered
    const result = await detector.finalize();

    expect(result.detected).toBe(false);
    expect(result.fullText).toBe('chunk1 chunk2 chunk3 chunk4 chunk5 ');
  });

  test('skips inference when previous one is pending', async () => {
    let callCount = 0;
    const encoder = createMockEncoder(0.2, 0.5, 5, 30);
    // Override predict to count calls
    (encoder as unknown as { predict: typeof predict }).predict = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 30));
      return 0.2;
    };
    const detector = new StreamingCrossroadDetector(encoder, {});

    // First chunk triggers inference (>= 5 chars)
    detector.onChunk('Hello world!');
    // Second chunk arrives while first inference is still pending — should skip
    detector.onChunk('Another chunk here.');

    await detector.finalize();

    // Only one inference should have run (the second was skipped)
    expect(callCount).toBe(1);
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    const encoder = createMockEncoder(0.9, 0.5, 10, 50);
    const detector = new StreamingCrossroadDetector(encoder, { signal: controller.signal });

    controller.abort();

    detector.onChunk('Hello world.');

    const result = await detector.finalize();

    expect(result.detected).toBe(false);
  });
});