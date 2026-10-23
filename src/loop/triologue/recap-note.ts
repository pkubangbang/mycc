/**
 * recap-note.ts - the brief result's success line and the recap note appended to it.
 *
 * A `brief` result is the durable note that survives a recap. Two writers
 * produce it and they must never drift:
 *
 *   1. the `brief` tool (+ the TOOL-stage plan-scope reflection) — the success
 *      result, "[<hash>] OK", optionally followed by a section;
 *   2. recap's rewind — it REWRITES that result in place with `noteWithSummary()`,
 *      so the collapsed span's summary lives in a TOOL RESULT (where the
 *      conversation still shows the anchor turn) instead of in a synthetic
 *      recap call appended at the end.
 *
 * THE HASH — every brief result opens with "[<hash>] ", where `<hash>` is a
 * short, readable token identifying THAT brief (the first 8 characters of the
 * brief's tool-call id). It is the LLM's handle on an anchor: `recap(target=
 * "<hash>")` rewinds to exactly that brief instead of the default (newest
 * solidified) one, and the model can see every candidate hash in the history
 * without the tool having to enumerate them. The hash is produced by
 * `briefResultLine(id)` and read back by `hashOf` / `stripHashPrefix` — the
 * same derivation, one module, so the two can never disagree.
 *
 * There is deliberately NO "is this result pristine / consumed" predicate.
 * Anchor eligibility is never decided from the result's TEXT: a brief anchors
 * iff it is not synthetic AND something follows its round-trip
 * (Triologue.hasMessagesAfterBrief), and a brief a recap already rewound here is
 * still eligible again once new activity lands. A content predicate would be a
 * second, divergent answer to "is this brief available" — and it invites exactly
 * the bug it looks like it prevents (a brief carrying an extra section being
 * mistaken for a consumed one).
 */

/**
 * Length of the hash shown in a brief result. 8 hex-ish chars is short enough
 * to read and quote, long enough that two briefs in one session never collide
 * in practice (ids carry a timestamp and a random tail).
 */
export const BRIEF_HASH_LENGTH = 8;

/**
 * The hash shown for a brief call — a stable PREFIX of its call id, never a
 * separate registry. `recap(target=…)` accepts either this hash or the full id
 * (see the triologue's anchor resolution), so a stale/partial id still lands.
 */
export function briefHash(callId: string | undefined): string {
  return (callId ?? '').slice(0, BRIEF_HASH_LENGTH);
}

/**
 * The success word of a brief result — `OK`. Exported so the `brief` tool (the
 * reporter, which does not know its call id) and the synthetic producers can
 * render the plain form without inventing a second literal.
 */
export const BRIEF_OK = 'OK';

/**
 * The success line a `brief` call answers with before any recap has touched it:
 * `[<hash>] OK` (with no trailing period — callers append it when prose follows).
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
 * message must not be labelled as an anchor) or that already carries a hash.
 */
export function stampBriefResult(content: string, callId: string | undefined): string {
  if (hashOf(content) !== null) return content;
  if (!content.startsWith(BRIEF_OK)) return content;
  if (!callId) return content;
  return `[${briefHash(callId)}] ${content}`;
}

/** Marker opening the note text appended after the success result. */
const NOTE_MARKER = 'Note, a recap has reset the conversation here with summary: ';

/** Opening bracket of the hash prefix in a brief result. */
const HASH_PREFIX_OPEN = '[';

/**
 * The section the TOOL stage appends to a brief result in PLAN mode (see
 * src/loop/plan-scope.ts). Defined here, next to the marker, so every known
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

/**
 * The rewritten brief result: the original success (hash line), followed by the
 * note.
 *
 * PURE OVERWRITE — the previous note (if any) is dropped. A second recap at the
 * same anchor replaces the summary rather than stacking summaries, so the
 * history never carries a chain of superseded notes. Anything else the result
 * carried (the plan-scope reflection) is overwritten too: the note is the
 * record of this stretch, and the reflection described work that is now folded
 * into it.
 *
 * The body is emitted verbatim after the marker. The caller composes it
 * (anchor header + summary) — this module deliberately does not re-encode it.
 */
export function noteWithSummary(callId: string | undefined, body: string): string {
  return `${briefResultLine(callId)} ${NOTE_MARKER}${body}`;
}

/**
 * Assemble the note BODY a recap writes into the anchor brief's tool result:
 * the `[RECAP]` header (label + quoted anchor brief) followed by the caller's
 * `additionalMessage`.
 *
 * SINGLE SOURCE OF TRUTH — both `Triologue.rewindToLastBrief` (which appends it
 * through `noteWithSummary`) and `Triologue.recapNoteSize` (which sizes it)
 * call this, so a caller's pre-check measures exactly the string the rewrite
 * will store.
 */
export function buildRecapNote(description: string, anchorMessage: string, additionalMessage: string): string {
  const header = [
    `[RECAP] ${description}`,
    anchorMessage ? `Rewound past the brief: "${anchorMessage}"` : '',
  ].filter(Boolean).join('\n');
  return `${header}\n\n${additionalMessage}`;
}

/**
 * Resolve a `recap(target=…)` argument to the brief it names.
 *
 * Accepts the hash shown in a brief result (`[<hash>] OK`, see `briefHash`) or
 * the full tool-call id it was derived from. Returns null when `target` names
 * no brief in `candidates` (each entry carries its call id) — the caller then
 * refuses the recap instead of silently rewinding somewhere else.
 */
export function resolveBriefTarget<T extends { id: string }>(
  target: string,
  candidates: readonly T[],
): T | null {
  const needle = target.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!needle) return null;
  // Exact id first, then the displayed hash (a prefix of the id).
  const exact = candidates.find((c) => c.id === needle);
  if (exact) return exact;
  const lowered = needle.toLowerCase();
  return candidates.find((c) => briefHash(c.id).toLowerCase() === lowered) ?? null;
}
