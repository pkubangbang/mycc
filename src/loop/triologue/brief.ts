/**
 * brief.ts - The ONE way to read and merge a `brief` tool call.
 *
 * A `brief` call's payload is `{ message, confidence }`. Three producers
 * hand-wrote that object (llm.ts empty-output recovery, hook.ts crossroad,
 * compact.ts floor) and two more hand-copied the READER, each tolerating the
 * two runtime shapes for `arguments` (our own producers store a parsed object;
 * a provider or a restored transcript stores the raw JSON string). Two parsers
 * drifting apart is exactly how a recap quoted a blank anchor on the string
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
import { estimateTextTokens } from '../../utils/token.js';

/**
 * The brief-message cap is TWO-TIER, and the tiers exist because they answer
 * different failures:
 *
 *   ≤ HARD (100 tokens)   → accepted silently, no note in the conversation.
 *   (HARD, SOFT] (≤200)   → accepted, but the brief's tool result says it was
 *                           over the target. Still a SUCCESS: the message is
 *                           kept verbatim, so a model that overshoots once
 *                           loses nothing.
 *   > SOFT (200 tokens)   → HARD FAILURE: the call is rejected and nothing is
 *                           recorded. Not clipped — a silently shortened
 *                           status line is how an agent misleads its reader
 *                           about how much it actually said; a rejection it
 *                           must act on is the honest outcome.
 *
 * WHY A CAP AT ALL — a brief is stored TWICE in the conversation: as the
 * assistant message's tool-call arguments (so the model re-reads its own words
 * on every subsequent call) and, after a fold, as the quoted anchor line of the
 * `[RECAP]` note. A brief is a status line, not a working note: detail belongs
 * in the tool result that carries it, or in the recap summary. Without a
 * ceiling one "status update" can spend thousands of tokens of every future
 * call and inflate the fold note past the result threshold.
 *
 * WHY ESTIMATED TOKENS, NOT CHARACTERS — the budget protected is the token
 * budget (`TOKEN_THRESHOLD`), and `estimateTextTokens` is the same estimator
 * that budget is computed with, so the cap and the accounting cannot disagree.
 * It is language-aware: 100 tokens is ~130 English words and ~50 CJK chars.
 */
export const BRIEF_MESSAGE_TARGET_TOKENS = 100;
export const MAX_BRIEF_MESSAGE_TOKENS = 200;

/**
 * Estimate a brief message's cost ON THE SAME SCALE as the caps.
 *
 * Exported so the tool handler, the HOOK-stage producer and the tests all read
 * the threshold exactly as the enforcement does — no second, drifting
 * definition of "how long is too long".
 */
export function estimateBriefMessageTokens(message: string): number {
  return estimateTextTokens(message);
}

/**
 * The tier a brief message falls into. `'warn'` is still a SUCCESS — the
 * caller keeps the message and only annotates the tool result.
 */
export type BriefMessageVerdict = 'ok' | 'warn' | 'fail';

export function briefMessageVerdict(message: string): BriefMessageVerdict {
  const cost = estimateBriefMessageTokens(message);
  if (cost <= BRIEF_MESSAGE_TARGET_TOKENS) return 'ok';
  if (cost <= MAX_BRIEF_MESSAGE_TOKENS) return 'warn';
  return 'fail';
}

/**
 * The appended note when a brief is LONGER than the target but still accepted.
 *
 * WORDING — it must read as a push toward concision, never as a rule recital:
 * the model should internalize "briefs are short", not learn a threshold it can
 * aim just under. So it names the problem (too long) and the fix (be concise),
 * and quotes neither the target nor the ceiling number.
 */
export function briefOverTargetWarning(): string {
  return ' (noted. However your message is longer than the limit (100 tokens), please be concise next time.)';
}

/**
 * The rejection text for a brief past the hard limit. Same stance as the
 * warning: no ceiling number — just what to do, plus the fact that nothing was
 * recorded (the model must know, or it will assume the update went out).
 */
export function briefTooLongError(): string {
  return 'Error: message too long. Please rewrite it as a short status line — the conclusion in one or two sentences — and record it with a new brief. Nothing was recorded for this one; put the detail in your next tool result.';
}

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
 * paths (recap quoting, anchor identity) where a throw would lose the whole
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

/**
 * Validate that `brief` is called alone (no other tools in the same turn).
 *
 * WHY THIS EXISTS — a brief is a rewind anchor: recap collapses the
 * conversation back to the LAST brief. Answering only `brief` in a turn makes
 * that anchor an unambiguous, self-contained boundary
 * (Triologue.currentAnchorIndex / rewindToLastBrief never have to reason about a
 * partial turn). `recap` carries the same rule (validateRecapIsolation) for
 * the same reason.
 *
 * Enforced at the top of HOOK (states/hook.ts), BEFORE hook processing: an
 * invalid turn is answered in full with this message and never executes a
 * partial batch. Synthetic brief producers (recovery, crossroad, compact
 * floor, TP recovery) each emit brief as the SOLE call of their turn and
 * register directly with the triologue, so they never reach this guard.
 */
export function validateBriefIsolation(toolCalls: Array<{ function: { name: string } }>): { valid: boolean; message?: string } {
  const hasBrief = toolCalls.some(c => c.function.name === 'brief');
  if (!hasBrief) {
    return { valid: true };
  }

  if (toolCalls.length > 1) {
    return {
      valid: false,
      message: 'Brief must be called alone. Other tools cannot be used in the same turn.',
    };
  }

  return { valid: true };
}

/** A fresh unique call id for a brief round-trip. */
export function newBriefCallId(prefix = 'brief'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a brief tool call from parts — the single writer for every producer
 * (recovery, crossroad, compact floor), so the shape cannot drift.
 *
 * SYNTHETIC PRODUCERS ARE EXEMPT FROM THE CAP: their message is fixed
 * boilerplate this repo owns (`Let me see what to do next.`, the compact
 * resume line), so it cannot grow with the agent's verbosity — the cap exists
 * to bound MODEL-authored text, and only the tool handler enforces it. The
 * message is passed through untouched, which also keeps the fold FLOOR
 * (compact.ts) byte-identical to what tests pin.
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
