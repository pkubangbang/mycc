/**
 * recap-note.ts - the brief result's success line and the recap note appended to it.
 *
 * A `brief` result is the durable note that survives a recap. Two writers
 * produce it and they must never drift:
 *
 *   1. the `brief` tool (+ the TOOL-stage plan-scope reflection) — the success
 *      result, whose FIRST LINE is the anchor line
 *      `[<hash>] ANCHOR — recap(target="<hash>") folds the work after this point`,
 *      optionally followed by `· open: <hashes>` and by a section (plan scope);
 *   2. recap's rewind — it APPENDS the note under that fixed first line with
 *      `noteWithSummary()`, so the collapsed span's summary lives in a TOOL
 *      RESULT (where the conversation still shows the anchor turn) instead of
 *      in a synthetic recap call appended at the end.
 *
 * LINE 1 IS STRUCTURE, LINE 2+ IS CONTENT. The anchor line is written once and
 * never rewritten — a recap adds its note below it — so an anchor stays visibly
 * an anchor (address included) after it has been folded.
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

import * as crypto from 'node:crypto';

/**
 * Length of the hash shown in a brief result.
 *
 * 8 CHARACTERS OF A DIGEST, not the first 8 characters of the call id: ids are
 * minted as `brief_<13-digit-ms>_<tail>` (triologue/brief.ts), so a prefix cut
 * renders `brief_17` for EVERY brief minted in the same ~1.15-day epoch — the
 * model would be offered a "target" that silently names the oldest match.
 * Hashing the whole id decorrelates the display from the id's flat prefix, so
 * two briefs colliding is the usual 1-in-16^8 birthday case.
 */
export const BRIEF_HASH_LENGTH = 8;

/**
 * The hash shown for a brief call — a stable digest of its call id, never a
 * separate registry. `recap(target=…)` accepts either this hash or the full id
 * (see resolveBriefTarget), so a stale/partial id still lands.
 *
 * Lower-case hex, so the display is readable and the comparison in
 * resolveBriefTarget is a plain string equality. `undefined` (a brief whose
 * call id was lost) hashes to '' and therefore renders `[]` — never a
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
 * The success word of a brief result — `OK`.
 *
 * The plain ack the `brief` TOOL HANDLER itself returns (it does not know its
 * call id). Kept as the handler's literal because the TOOL stage recognises it
 * to decide whether a result is a pristine success worth stamping; the result
 * the MODEL sees replaces this word with {@link BRIEF_ANCHOR_WORD}.
 */
export const BRIEF_OK = 'OK';

/**
 * The success word the MODEL sees: `ANCHOR`.
 *
 * WHY NOT `OK` (docs/loop/brief-and-recap-rewind.md, "surfacing the anchor"):
 * `OK` is the vocabulary of a tool RECEIPT — the model reads `[a1b2c3d4] OK.`
 * as "this call finished, nothing to do here" and files the hash away as
 * decoration. `ANCHOR` names the OBJECT the hash addresses, which is the only
 * in-transcript evidence that `recap(target="a1b2c3d4")` has anything to point
 * at. It is the same three characters' worth of structure, a different
 * category in the model's vocabulary.
 */
export const BRIEF_ANCHOR_WORD = 'ANCHOR';

/**
 * The fixed first line of every brief result:
 *
 *   [<hash>] ANCHOR — recap(target="<hash>") folds the work after this point
 *
 * LINE 1 IS STRUCTURE, NEVER CONTENT. It is written once and never rewritten:
 * the anchor's identity, its address and the shape of the call that uses it all
 * survive a recap, so a brief that has already been folded is still visibly an
 * anchor the next time the model reads the history. A recap's summary is
 * appended as a SECOND line ({@link noteWithSummary}) — that append is the only
 * thing a rewind changes.
 *
 * The bracket/hash position is part of the contract: `hashOf` reads `[<hash>]`
 * off the front and `resolveBriefTarget` accepts the same spelling, so the
 * hash must stay where it has always been.
 *
 * `undefined` (a brief whose call id was lost) still renders a well-formed line
 * with an empty hash — never a plausible-looking token naming some other brief.
 */
export function briefResultLine(callId: string | undefined): string {
  const hash = briefHash(callId);
  // NAME THE SPAN, NOT A DIRECTION: a rewind keeps everything UP TO this brief
  // and deletes what came AFTER it. "everything above" reads as "everything above
  // this line in the transcript" — the opposite span — and a model that believes
  // recap deletes its earlier history has every reason never to call it.
  return `[${hash}] ${BRIEF_ANCHOR_WORD} — ${foldCall(hash)} folds the work after this point`;
}

/**
 * The shape of the call that folds to `hash` — the ONLY place that spelling is
 * written, so line 1, the recap tool description and the prompt section cannot
 * drift apart.
 */
export function foldCall(hash: string): string {
  return `recap(target="${hash}")`;
}

/**
 * The result line a brief gets when the anchor line would be a FALSE affordance.
 *
 * Two callers hit this:
 *
 *   - a CHILD-scope brief: `brief` is `['main', 'child']` but `recap` is
 *     `['main']`, so a teammate that reads `recap(target=…)` is being told to
 *     call a tool it does not have (see the audience note in src/tools/brief.ts);
 *   - a synthetic brief (crossroad, empty-output recovery): it is excluded from
 *     `store.briefIndices()`, so every `recap(target=…)` naming it is REFUSED.
 *
 * The hash stays at the front — `hashOf` / `stripHashPrefix` still read it — but
 * the line promises nothing. Before this line existed, those results were a
 * plain `[<hash>] OK`, which is exactly the neutral receipt wanted here.
 */
export function briefReceiptLine(callId: string | undefined): string {
  return `[${briefHash(callId)}] ${BRIEF_OK}`;
}

/**
 * True when a first line still carries the `recap(target=…)` invitation —
 * exactly the clause {@link withoutFoldInvitation} removes.
 *
 * Used by a rewind to decide whether the anchor line is a LIVE anchor line at
 * all: a legacy one-line result (`[<hash>] OK Note, …`) or any line that never
 * carried an invitation is not one, and keeping it as "line 1" would duplicate
 * its old summary under the new note.
 */
export function hasFoldInvitation(line: string | undefined): boolean {
  if (typeof line !== 'string') return false;
  return FOLD_INVITATION_RE.test(line);
}

/**
 * The same first line, with the invitation retired: the hash and the ANCHOR word
 * stay (the anchor is still an anchor), the call shape and the verb go.
 *
 * `[<hash>] ANCHOR — recap(target="h") folds the work after this point`
 *   → `[<hash>] ANCHOR`
 */
export function withoutFoldInvitation(line: string): string {
  return line.replace(FOLD_INVITATION_RE, '');
}

/**
 * Append the "other anchors you could fold instead" hint to a brief result
 * line, when there are any.
 *
 * `candidates` are the OTHER addressable briefs, newest first (see
 * `BriefStackManager.listBriefHashes`) — the just-created brief is excluded by
 * the caller: it has nothing after it yet, so it is not itself a rewind target,
 * but it DOES make every earlier solidified brief one.
 *
 * Rendered at most {@link OPEN_LIST_MAX} entries (an unbounded list is token
 * soup in which the actionable clause gets lost), oldest-last so the newest
 * candidate — the default target — reads first.
 *
 * ABOVE the cap the list still starts with the newest {@link OPEN_LIST_MAX} and
 * ends with a count (`· open: a, b, c (+2 more)`): the retrievable targets stay
 * named, the remainder is acknowledged without implying it can be enumerated
 * (there is no list-anchors tool — the tail is a fact, not an offer).
 */
export const OPEN_LIST_MAX = 3;

export function withOpenAnchors(line: string, candidates: readonly string[]): string {
  if (candidates.length === 0) return line;
  const shown = candidates.slice(0, OPEN_LIST_MAX).join(', ');
  // Above the cap the line still ends with the COUNT: the tail must stay truthful
  // without naming targets the model cannot retrieve (no tool enumerates
  // anchors), and the count alone would break the `· open:` shape the prompt and
  // the tool description both describe.
  if (candidates.length > OPEN_LIST_MAX) {
    return `${line} · open: ${shown} (+${candidates.length - OPEN_LIST_MAX} more)`;
  }
  return `${line} · open: ${shown}`;
}

/**
 * Stamp a finished `brief` tool result with the anchor line — the ONE place
 * the anchor rendering is applied to a real tool result.
 *
 * Applied by the TOOL stage after the `brief` tool returns, because a tool
 * handler receives no call id; the loop owns the id the hash is derived from
 * (and, unlike the handler, can see the stack the candidate list comes from).
 *
 * Idempotent, and a no-op on anything that is not a pristine success (an error
 * message must not be labelled as an anchor) or that already carries a hash.
 * When the result is a success carrying a section after the ack (`OK. When
 * thinking on the larger scope, …`), the section is preserved VERBATIM after
 * the anchor line — the anchor replaces the ack word, it does not swallow the
 * reflection.
 */
export function stampBriefResult(
  content: string,
  callId: string | undefined,
  openAnchors: readonly string[] = [],
): string {
  if (hashOf(content) !== null) return content;
  if (!content.startsWith(BRIEF_OK)) return content;
  if (!callId) return content;
  // Drop the ack word (and the period that terminated it) but keep everything
  // the result carried after it.
  const rest = content.slice(BRIEF_OK.length).replace(/^\.\s*/, '').trim();
  const line = withOpenAnchors(briefResultLine(callId), openAnchors);
  return rest ? `${line}\n${rest}` : line;
}

/**
 * The rendered length of a stamped result, WITHOUT the caller's content — so a
 * producer that budgets for its own text (the plan-scope reflection) reserves
 * the real first line instead of guessing at it.
 *
 * `openAnchors` is the live candidate list, exactly as the TOOL stage will pass
 * it (pass the same array to {@link stampBriefResult}); anything after line 1
 * adds to it, so a caller reserves `briefStampedLength(id, open) + ownText`.
 */
export function briefStampedLength(callId: string | undefined, openAnchors: readonly string[] = []): number {
  return withOpenAnchors(briefResultLine(callId), openAnchors).length;
}

/** The invitation clause of line 1 — ONE spelling, used to test and to remove. */
const FOLD_INVITATION_RE = / — recap\(target="[^"]*"\)[^\n]*$/;

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
  // The plan-scope reflection is the SECOND line of an anchored result (line 1
  // is the fixed anchor line), so match it as a whole line anywhere in the
  // body rather than only at the front. Legacy `[<hash>] OK. When thinking…`
  // results still match: the section is the remainder of that same line.
  return content.split('\n').some((line) => line.trim().startsWith(PLAN_SCOPE_HEADING));
}

/**
 * Drop a leading `[<hash>] ` from a brief result, leaving the rest. Returns
 * `content` unchanged when it carries no prefix (the display path must never
 * lose text it does not recognise).
 *
 * Only the PREFIX goes: an anchored result's remaining lines (the anchor prose
 * and any recap note) are kept verbatim, and a legacy `OK. <section>` result
 * keeps its section after the ack word.
 */
export function stripHashPrefix(content: string): string {
  if (typeof content !== 'string' || !content.startsWith(HASH_PREFIX_OPEN)) return content;
  const close = content.indexOf(']');
  if (close <= 1) return content;
  // Skip the single space that separates the hash from the prose.
  const rest = content.startsWith('] ', close) ? content.slice(close + 2) : content.slice(close + 1);
  // Legacy results continue `OK. <prose>`; an anchored result opens with its own
  // line and puts the content on the next one. Either way the status line is not
  // prose — drop it, but never drop a section that follows.
  return rest
    .replace(new RegExp(`^${BRIEF_OK}\\.\\s*`), '')
    .replace(/^ANCHOR(?: — | · )[^\n]*(?:\n|$)/, '')
    .replace(/^ANCHOR(?:\n|$)/, '');
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
export function noteWithSummary(callId: string | undefined, body: string, firstLine?: string): string {
  // An id-less anchor renders no address rather than a fake one: `[] ANCHOR —
  // recap(target="")` would offer a call that can never resolve.
  const fallback = callId ? briefResultLine(callId) : `[] ${BRIEF_ANCHOR_WORD}`;
  // LINE 1 IS STRUCTURE, LINE 2 IS THE RECAP. The caller passes the anchor
  // line the result already carries (the live first line, with its candidate
  // list frozen at the moment the brief landed) so the rewind APPENDS below it
  // instead of re-rendering — the anchor's identity must survive untouched.
  //
  // The one thing the rewind DOES change is the invitation: once this anchor is
  // folded, "recap(target=…) folds the work after this point" names an empty span, so a
  // still-frozen call would fail the model on its own successful use.
  const anchorLine = firstLine ?? fallback;
  return `${withoutFoldInvitation(anchorLine)}\n${NOTE_MARKER}${body}`;
}

/**
 * The exact length {@link noteWithSummary} writes for one anchored result —
 * the number `recapNoteSize` must compare against the result threshold.
 */
export function anchoredNoteLength(firstLine: string, body: string): number {
  return `${withoutFoldInvitation(firstLine)}`.length + 1 + NOTE_MARKER.length + body.length;
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
 * Accepts the hash shown in a brief result (`[<hash>] ANCHOR …`, see `briefHash`) or
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
