/**
 * recap-note.ts - the brief result's success line and its hash prefix.
 *
 * (Historical name: the module USED to own the recap note as well; the recap
 * tool is gone, and what remains is the brief result format that the `brief`
 * tool, the TOOL-stage plan-scope reflection and synthetic brief producers all
 * share. Kept at its original path so imports stay stable.)
 *
 * A `brief` result is the durable note for the stretch of work that follows the
 * brief. Its format is fixed:
 *
 *   "[<hash>] OK"                 — the plain success line (briefResultLine)
 *   "[<hash>] OK <section text>"  — with a section appended (plan-scope)
 *
 * THE HASH — every brief result opens with "[<hash>] ", where `<hash>` is a
 * short, readable token identifying THAT brief (a digest of the brief's
 * tool-call id). It is the model's handle on a specific brief round-trip: the
 * history shows every candidate hash without any tool having to enumerate
 * them, and a reader (human or model) can refer to a brief by that token. The
 * hash is produced by `briefResultLine(id)` and read back by `hashOf` /
 * `stripHashPrefix` — the same derivation, one module, so the two can never
 * disagree.
 *
 * There is deliberately NO "is this result pristine / consumed" predicate: the
 * result's TEXT is display data, never a state flag.
 */

import * as crypto from 'node:crypto';

/**
 * Length of the hash shown in a brief result.
 *
 * 8 CHARACTERS OF A DIGEST, not the first 8 characters of the call id: ids are
 * minted as `brief_<13-digit-ms>_<tail>` (triologue/brief.ts), so a prefix cut
 * renders `brief_17` for EVERY brief minted in the same ~1.15-day epoch. Hashing
 * the whole id decorrelates the display from the id's flat prefix, so two
 * briefs colliding is the usual 1-in-16^8 birthday case.
 */
export const BRIEF_HASH_LENGTH = 8;

/**
 * The hash shown for a brief call — a stable digest of its call id, never a
 * separate registry.
 *
 * Lower-case hex, so the display is readable. `undefined` (a brief whose call
 * id was lost) hashes to '' and therefore renders `[]` — never a
 * plausible-looking token that would name some other brief.
 */
export function briefHash(callId: string | undefined): string {
  if (!callId) return '';
  return crypto
    .createHash('sha256')
    .update(callId)
    .digest('hex')
    .slice(0, BRIEF_HASH_LENGTH);
}

/**
 * The success word of a brief result — `OK`. Exported so the `brief` tool (the
 * reporter, which does not know its call id) and the synthetic producers can
 * render the plain form without inventing a second literal.
 */
export const BRIEF_OK = 'OK';

/**
 * The success line a `brief` call answers with: `[<hash>] OK` (with no trailing
 * period — callers append it when prose follows).
 */
export function briefResultLine(callId: string | undefined): string {
  return `[${briefHash(callId)}] ${BRIEF_OK}`;
}

/**
 * Stamp a finished `brief` tool result with the anchor hash — `[<hash>] OK` —
 * the ONE place the hash prefix is applied to a real tool result.
 *
 * Applied by the TOOL stage after the `brief` tool returns, because a tool
 * handler receives no call id; the loop owns the id the hash is derived from.
 * Idempotent, and a no-op on anything that is not a success result (an error
 * message must not be labelled with a hash) or that already carries one.
 */
export function stampBriefResult(content: string, callId: string | undefined): string {
  if (hashOf(content) !== null) return content;
  if (!content.startsWith(BRIEF_OK)) return content;
  if (!callId) return content;
  return `[${briefHash(callId)}] ${content}`;
}

/** Opening bracket of the hash prefix in a brief result. */
const HASH_PREFIX_OPEN = '[';

/**
 * The section the TOOL stage appends to a brief result in PLAN mode (see
 * src/loop/plan-scope.ts). Defined here, next to the format, so every known
 * section of a brief result is declared in one place.
 */
export const PLAN_SCOPE_HEADING = 'When thinking on the larger scope';

/**
 * The hash a brief result opens with, or null when `content` does not carry the
 * `[<hash>] …` prefix (a legacy/synthetic result, or a non-brief tool result).
 */
export function hashOf(content: string | undefined): string | null {
  if (typeof content !== 'string' || !content.startsWith(HASH_PREFIX_OPEN)) return null;
  const close = content.indexOf(']');
  if (close <= 1) return null;
  const hash = content.slice(1, close);
  return /^[A-Za-z0-9_-]+$/.test(hash) ? hash : null;
}

/** True when `content` is a brief result carrying the plan-scope section. */
export function hasPlanScopeSection(content: string | undefined): boolean {
  if (typeof content !== 'string') return false;
  // The success word sits between the hash and the section ([<hash>] OK. When…),
  // so drop a leading hash AND a leading success word before matching.
  const prose = stripHashPrefix(content).replace(/^\S+\.\s+/, '');
  return prose.startsWith(PLAN_SCOPE_HEADING);
}

/**
 * Drop a leading `[<hash>] ` from a brief result, leaving the prose. Returns
 * `content` unchanged when it carries no prefix (the display path must never
 * lose text it does not recognise).
 */
export function stripHashPrefix(content: string): string {
  if (typeof content !== 'string' || !content.startsWith(HASH_PREFIX_OPEN)) return content;
  const close = content.indexOf(']');
  if (close <= 1) return content;
  // Skip the single space that separates the hash from the prose.
  return content.startsWith('] ', close) ? content.slice(close + 2) : content.slice(close + 1);
}
