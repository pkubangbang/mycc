/**
 * brief.ts - The ONE way to read and build a `brief` tool call.
 *
 * A `brief` call's payload is `{ message, confidence }`. Three producers
 * hand-wrote that object (llm.ts empty-output recovery, hook.ts crossroad,
 * compact.ts floor) and two more hand-copied the READER, each tolerating the
 * two runtime shapes for `arguments` (our own producers store a parsed object;
 * a provider or a restored transcript stores the raw JSON string). Two parsers
 * drifting apart is exactly how a reader quoted a blank brief on the string
 * path, so both directions live here now.
 */

import type { ToolCall } from '../../types.js';

/** A parsed brief payload. Both fields are optional: a malformed brief is
 *  still a brief (its calls anchor, its tool result still closes the pair). */
export interface BriefArgs {
  message?: string;
  confidence?: number;
}

/**
 * Parse a brief call's `arguments` from either runtime shape.
 *
 * Returns `{}` for a malformed payload rather than throwing: readers are on
 * paths (brief quoting, checkpoint identity) where a throw would lose the whole
 * operation for a cosmetic defect.
 */
export function parseBriefArgs(call: { function: { arguments?: unknown } }): BriefArgs {
  const raw = call.function.arguments;
  let args: unknown = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!args || typeof args !== 'object') return {};
  const record = args as Record<string, unknown>;
  const out: BriefArgs = {};
  if (typeof record.message === 'string') out.message = record.message;
  if (typeof record.confidence === 'number') out.confidence = record.confidence;
  return out;
}

/** The brief's `message`, or '' when absent/unreadable. */
export function readBriefMessage(call: { function: { arguments?: unknown } }): string {
  return parseBriefArgs(call).message ?? '';
}

/** The brief's `confidence`, or undefined when absent/unreadable. */
export function readBriefConfidence(call: { function: { arguments?: unknown } }): number | undefined {
  return parseBriefArgs(call).confidence;
}

/** A fresh unique call id for a brief round-trip. */
export function newBriefCallId(prefix = 'brief'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a brief tool call from parts — the single writer for every producer
 * (recovery, crossroad, compact floor), so the shape cannot drift.
 */
export function briefToolCall(
  message: string,
  confidence: number,
  id: string = newBriefCallId(),
): ToolCall {
  return {
    id,
    function: { name: 'brief', arguments: { message, confidence } },
  };
}
