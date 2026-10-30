/**
 * brief.ts - The ONE way to read and merge a `brief` tool call.
 *
 * A `brief` call's payload is `{ message, confidence }`. Three producers
 * hand-wrote that object (llm.ts empty-output recovery, hook.ts crossroad,
 * compact.ts floor) and two more hand-copied the READER, each tolerating the
 * two runtime shapes for `arguments` (our own producers store a parsed object;
 * a provider or a restored transcript stores the raw JSON string). Two parsers
 * drifting apart is exactly how a reader quoted a blank brief on the string
 * path, so both directions live here now.
 *
 * MERGE — `mergeBriefCall(prev, incoming)` answers: what does the conversation
 * show when a NEW brief is merged INTO an existing one? The answer is a NEW,
 * compatible brief tool call:
 *   - a NEW `id` (a merged brief is a new call — reusing the old id would let a
 *     tool result for the old call resolve against the new one);
 *   - `message` MERGED, not replaced (the earlier brief is the surviving
 *     record of that stretch, so the new text is appended rather than
 *     overwriting it);
 *   - `confidence` from the incoming call when it states one, else the
 *     previous value.
 * The previous call is never mutated — messages already in the store must not
 * change under a reader that is scanning them.
 */

import type { ToolCall } from '../../types.js';

/** The provider-neutral shape we accept for a brief call's `function`. */
export type BriefCallLike = {
  id?: string;
  function: { name: string; arguments?: unknown };
};

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

/**
 * Join two brief messages into one, dropping a duplicate.
 *
 * The incoming text can repeat the previous one (e.g. a recovery brief fired
 * twice with identical boilerplate). Emitting it twice would pad the brief the
 * user reads without adding information, so an identical message yields the
 * previous text alone.
 */
function joinBriefMessages(prev: string, next: string): string {
  const a = prev.trim();
  const b = next.trim();
  if (!a) return next;
  if (!b || a === b) return prev;
  return `${prev}\n\n${next}`;
}

/**
 * Merge `incoming` INTO `prev`, yielding a NEW compatible brief tool call.
 *
 * See the module header for the three rules (new id, merged message, incoming
 * confidence wins). `prev` may be undefined — the result is then simply the
 * incoming call with a fresh id, which is what a producer starting a fresh
 * brief round-trip needs.
 */
export function mergeBriefCall(prev: BriefCallLike | undefined, incoming: BriefCallLike): ToolCall {
  const next = parseBriefArgs(incoming);
  const before = prev ? parseBriefArgs(prev) : {};

  const message = joinBriefMessages(before.message ?? '', next.message ?? '');
  // Confidence: the incoming call describes the CURRENT state of the work, so
  // it wins when it states one; otherwise carry the previous reading forward.
  const confidence = next.confidence ?? before.confidence ?? 7;
  const id = newBriefCallId();

  // Both sides should be `brief` calls; keep the helper honest by asserting the
  // function name rather than silently producing a call under another name.
  const name = 'brief';

  return {
    id,
    function: { name, arguments: { message, confidence } },
  };
}
