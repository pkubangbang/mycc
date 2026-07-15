/**
 * streaming-crossroad-detector.ts - Streaming crossroad detector
 *
 * Accumulates text during LLM output and periodically runs encoder inference
 * to detect turning points mid-stream. When the ONNX encoder is unavailable
 * (null), it simply accumulates text without inference, allowing the caller
 * to fall back to the existing regex detector.
 *
 * Design:
 * - onChunk() is synchronous and non-blocking — inference is fire-and-forget
 * - Only one inference runs at a time; overlapping requests are skipped
 * - finalize() awaits any pending inference before returning the result
 */

import type { CrossroadEncoder } from './crossroad-encoder.js';
import { agentIO } from './agent-io.js';

export interface StreamingDetectorOptions {
  signal?: AbortSignal;
}

export interface StreamingDetectorResult {
  detected: boolean;
  fullText: string;
  turnIndex: number;
}

export class StreamingCrossroadDetector {
  private encoder: CrossroadEncoder | null;
  private signal: AbortSignal | undefined;
  private checkInterval: number;

  private accumulatedText: string = '';
  private lastCheckPosition: number = 0;
  private detectedTurnIndex: number = -1;
  private pendingInference: Promise<void> | null = null;

  constructor(encoder: CrossroadEncoder | null, options: StreamingDetectorOptions = {}) {
    this.encoder = encoder;
    this.signal = options.signal;
    // When encoder is null, set checkInterval to Infinity so onChunk
    // never triggers inference — just accumulates text for regex fallback.
    this.checkInterval = encoder?.getConfig().checkInterval ?? Infinity;
  }

  /**
   * Synchronously accumulate text; periodically fire-and-forget inference.
   *
   * When accumulated length minus last check position >= checkInterval,
   * start an async inference (if none is pending). If previous inference
   * is still running, skip this check.
   */
  onChunk(contentDelta: string): void {
    this.accumulatedText += contentDelta;

    // No encoder → just accumulate, no inference
    if (!this.encoder) return;

    // Not enough new content since last check
    if (this.accumulatedText.length - this.lastCheckPosition < this.checkInterval) return;

    // Previous inference still pending — skip
    if (this.pendingInference !== null) return;

    // Fire-and-forget async inference
    this.pendingInference = this.runInference();
  }

  /**
   * Run encoder inference on the accumulated text.
   * If P(turn) > threshold, record the turn index at current text length.
   * Catches errors silently (verbose log only).
   */
  private async runInference(): Promise<void> {
    if (!this.encoder) return;

    // Abort check
    if (this.signal?.aborted) {
      this.pendingInference = null;
      return;
    }

    const textToCheck = this.accumulatedText;
    const checkPosition = textToCheck.length;

    try {
      const prob = await this.encoder.predict(textToCheck);
      const threshold = this.encoder.getConfig().threshold;

      agentIO.verbose('streaming-crossroad', `P(turn)=${prob.toFixed(4)} (threshold=${threshold}) at pos=${checkPosition}`);

      if (prob > threshold) {
        this.detectedTurnIndex = checkPosition;
        agentIO.verbose('streaming-crossroad', `Turn detected at position ${checkPosition}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentIO.verbose('streaming-crossroad', `Inference error: ${msg}`);
    } finally {
      this.lastCheckPosition = checkPosition;
      this.pendingInference = null;
    }
  }

  /**
   * Await any pending inference and return the final result.
   *
   * If encoder is null, returns { detected: false, ... } so the caller
   * falls back to the regex detector.
   */
  async finalize(): Promise<StreamingDetectorResult> {
    if (this.pendingInference !== null) {
      await this.pendingInference;
    }

    return {
      detected: this.detectedTurnIndex >= 0,
      fullText: this.accumulatedText,
      turnIndex: this.detectedTurnIndex,
    };
  }
}