/**
 * request-embedding.ts - Semantic duplication detection via embedding similarity
 *
 * Maintains an in-memory rolling window of the last 20 agent tool calls,
 * converts each into an embedding vector via Ollama, and computes cosine
 * similarity to detect when the agent is semantically repeating itself.
 *
 * The max similarity is mapped to a confusion delta (+0 to +2) and fed
 * into the confusion index for hint round triggering.
 */

import { getEmbedding } from '../engine/ollama-embedding.js';
import { agentIO } from './agent-io.js';

/** A single tracked tool call with its embedding */
interface TrackedEntry {
  /** Text representation of the tool call (≤1000 chars) */
  text: string;
  /** Embedding vector from Ollama */
  embedding: number[];
  /** Tool name */
  tool: string;
  /** When the call was made */
  timestamp: number;
}

/**
 * In-memory tracker for semantic duplication detection.
 *
 * Maintains a rolling buffer of the last 20 tool calls. Each call is
 * converted to a text representation, embedded via Ollama, and compared
 * against all previous entries via cosine similarity.
 */
export class RequestEmbeddingTracker {
  private buffer: TrackedEntry[] = [];
  private readonly MAX_SIZE = 20;
  // TODO: make MAX_TEXT_LENGTH configurable via env var
  private readonly MAX_TEXT_LENGTH = 1000;
  /** Max chars per individual arg value before truncation */
  private readonly MAX_VALUE_LENGTH = 200;

  /**
   * Add a tool call to the rolling buffer.
   * Generates embedding for the text representation.
   * If getEmbedding() fails (Ollama down), catches silently and skips.
   */
  async addEntry(toolName: string, args: Record<string, unknown>): Promise<void> {
    try {
      const text = this.buildText(toolName, args);
      const embedding = await getEmbedding(text);

      this.buffer.push({
        text,
        embedding,
        tool: toolName,
        timestamp: Date.now(),
      });

      // Evict oldest if over capacity
      if (this.buffer.length > this.MAX_SIZE) {
        this.buffer.shift();
      }
    } catch (err) {
      // Graceful degradation: if Ollama is down, skip silently
      agentIO.verbose('embedding', `Failed to embed tool call ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Build a text representation of a tool call for embedding.
   * Format: "tool_name: key1="value1", key2="value2""
   * Long values are truncated to MAX_VALUE_LENGTH.
   * Final string is truncated to MAX_TEXT_LENGTH.
   */
  private buildText(toolName: string, args: Record<string, unknown>): string {
    const parts: string[] = [`${toolName}:`];

    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      let strValue: string;
      if (typeof value === 'string') {
        strValue = value;
      } else if (typeof value === 'object') {
        strValue = JSON.stringify(value);
      } else {
        strValue = String(value);
      }
      // Truncate long values to prevent noise
      if (strValue.length > this.MAX_VALUE_LENGTH) {
        strValue = `${strValue.slice(0, this.MAX_VALUE_LENGTH)}...`;
      }
      parts.push(`${key}="${strValue}"`);
    }

    const text = parts.join(' ');
    // Truncate final string to max length
    if (text.length > this.MAX_TEXT_LENGTH) {
      return text.slice(0, this.MAX_TEXT_LENGTH);
    }
    return text;
  }

  /**
   * Find the maximum cosine similarity between the latest entry
   * and all previous entries in the buffer.
   * Returns 0 if buffer has fewer than 2 entries.
   */
  getMaxSimilarity(): number {
    if (this.buffer.length < 2) return 0;

    const latest = this.buffer[this.buffer.length - 1];
    let maxSim = 0;

    for (let i = 0; i < this.buffer.length - 1; i++) {
      const sim = this.cosineSimilarity(latest.embedding, this.buffer[i].embedding);
      if (sim > maxSim) maxSim = sim;
    }

    return maxSim;
  }

  /**
   * Map a similarity score (0.0–1.0) to a confusion delta (0–2).
   *
   *   < 0.7   → 0  (no significant similarity)
   *   0.7–0.85 → +1 (moderate similarity — possible loop)
   *   > 0.85  → +2 (high similarity — likely stuck)
   */
  similarityToDelta(similarity: number): number {
    if (similarity > 0.85) return 2;
    if (similarity >= 0.7) return 1;
    return 0;
  }

  /**
   * Get a human-readable duplication report for the hint round.
   * Lists pairs with similarity above 0.7.
   * Returns empty string if no significant duplication found.
   */
  getDuplicationReport(): string {
    if (this.buffer.length < 2) return '';

    const lines: string[] = ['Semantic Duplication Analysis:'];
    let found = false;

    // Only report pairs involving the last 5 entries to keep the report
    // focused on recent/active duplication rather than stale historical pairs.
    const recentStart = Math.max(0, this.buffer.length - 5);

    for (let i = 1; i < this.buffer.length; i++) {
      const latest = this.buffer[i];
      for (let j = 0; j < i; j++) {
        // Skip pairs where neither entry is in the recent window
        if (i < recentStart && j < recentStart) continue;

        const sim = this.cosineSimilarity(latest.embedding, this.buffer[j].embedding);
        if (sim >= 0.7) {
          found = true;
          lines.push(`  - Call #${i + 1} ("${latest.tool}") similar to Call #${j + 1} ("${this.buffer[j].tool}"): similarity=${sim.toFixed(3)}`);
        }
      }
    }

    if (!found) return '';
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Clear the buffer (e.g., after auto-compact).
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Calculate cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
