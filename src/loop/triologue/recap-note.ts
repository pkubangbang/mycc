/**
 * recap-note.ts - the brief result's success line and the recap note appended to it.
 *
 * A `brief` result is the durable note that survives a recap. Two writers
 * produce it and they must never drift:
 *
 *   1. the `brief` tool (+ the TOOL-stage plan-scope reflection) — the success
 *      result, whose FIRST LINE is the anchor line
 *      `[<hash>] ANCHOR — recap(target_brief="<hash>") folds the work after this point`,
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
 * brief's tool-call id). It is the LLM's handle on an anchor: `recap(target_brief=
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
 * separate registry. `recap(target_brief=…)` accepts either this hash or the full id
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
 * in-transcript evidence that `recap(target_brief="a1b2c3d4")` has anything to point
 * at. It is the same three characters' worth of structure, a different
 * category in the model's vocabulary.
 */
export const BRIEF_ANCHOR_WORD = 'ANCHOR';

/**
 * The fixed first line of every brief result:
 *
 *   [<hash>] ANCHOR — recap(target_brief="<hash>") folds the work after this point
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
  return `recap(target_brief="${hash}")`;
}

/**
 * The result line a brief gets when the anchor line would be a FALSE affordance.
 *
 * Two callers hit this:
 *
 *   - a CHILD-scope brief: `brief` is `['main', 'child']` but `recap` is
 *     `['main']`, so a teammate that reads `recap(target_brief=…)` is being told to
 *     call a tool it does not have (see the audience note in src/tools/brief.ts);
 *   - a synthetic brief (crossroad, empty-output recovery): it is excluded from
 *     `store.briefIndices()`, so every `recap(target_brief=…)` naming it is REFUSED.
 *
 * The hash stays at the front — `hashOf` / `stripHashPrefix` still read it — but
 * the line promises nothing. Before this line existed, those results were a
 * plain `[<hash>] OK`, which is exactly the neutral receipt wanted here.
 */
export function briefReceiptLine(callId: string | undefined): string {
  return `[${briefHash(callId)}] ${BRIEF_OK}`;
}

/**
 * True when a first line still carries the `recap(target_brief=…)` invitation —
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
 * `[<hash>] ANCHOR — recap(target_brief="h") folds the work after this point`
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
const FOLD_INVITATION_RE = / — recap\(target_brief="[^"]*"\)[^\n]*$/;

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
  // recap(target_brief="")` would offer a call that can never resolve.
  const fallback = callId ? briefResultLine(callId) : `[] ${BRIEF_ANCHOR_WORD}`;
  // LINE 1 IS STRUCTURE, LINE 2 IS THE RECAP. The caller passes the anchor
  // line the result already carries (the live first line, with its candidate
  // list frozen at the moment the brief landed) so the rewind APPENDS below it
  // instead of re-rendering — the anchor's identity must survive untouched.
  //
  // The one thing the rewind DOES change is the invitation: once this anchor is
  // folded, "recap(target_brief=…) folds the work after this point" names an empty span, so a
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

/** Heading of the open-todo section appended to a recap note. */
export const OPEN_TODOS_HEADING = '### Open todos';

/** Per-row text budget for the recap section (mirrors serve-todos' MAX_TEXT_LEN). */
const MAX_TODO_TEXT_LEN = 500;

/**
 * Total character budget for the rendered section.
 *
 * DERIVED FROM THE GATE IT PROTECTS, not a row count (round-2 review, major #2).
 * A fixed "40 rows" cap looked bounded but was not: 40 rows × 3 fields × 500 chars
 * ≈ 61 500 chars, against a default `getResultThreshold()` of 50 000 — so a session
 * with enough pinned, maximal-note rows still made EVERY recap permanently refused,
 * which is the exact failure this section was supposed to stop. Pinned rows never
 * auto-clear, so it only grows.
 *
 * Kept a little under the threshold to leave room for the note's other two parts
 * (the [RECAP] header and the span summary). `formatOpenTodos` is a pure renderer
 * with no access to the live threshold, so this is a deliberately conservative
 * constant; `recapNoteSize` remains the authoritative final check.
 */
const MAX_TODO_SECTION_CHARS = 20_000;

/** Flatten + clamp one free-form field so it cannot forge note structure. */
function clampTodoText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Collapse every line break and control char: a name containing "\n### " would
  // otherwise forge a section heading inside a durable note the model reads as
  // authoritative state (review m1).
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > MAX_TODO_TEXT_LEN ? `${flat.slice(0, MAX_TODO_TEXT_LEN)}…` : flat;
}

/**
 * The OPEN todos a recap should carry forward, rendered as the note's third
 * part — or `''` when there is nothing to say.
 *
 * ## Deliberately NOT built (recorded so they are not re-proposed)
 *
 * Two designs for "keep the todo list in front of the model" were considered and
 * rejected. Neither is an oversight; each has a concrete reason.
 *
 * 1. A `todo_list` TOOL the model calls to refresh the list. REJECTED: this repo
 *    already tried a proactive `checkpoint` tool and it failed for a reason that
 *    generalises — the LLM never knew when to call it (pitfall `c5e0818f`:
 *    "A manual 'checkpoint' tool failed: the LLM never knew to call it. Fix:
 *    passive anchors…"). A tool whose only trigger is the model's own judgement
 *    about its own attention is not a mechanism. Delivery must not depend on the
 *    agent choosing to ask.
 *
 * 2. A PER-TURN injection of the list into the project context. REJECTED: the
 *    project-context populators are frozen between `compact()`/`clear()`
 *    boundaries ON PURPOSE — see `prompt-populators.ts` — because refreshing them
 *    every turn invalidated the provider's prompt-cache prefix on each request.
 *    `collect.ts` states the same rule independently: the list "must NOT be
 *    re-injected as a per-turn REMINDER".
 *
 * What ships instead is a two-layer split, each layer honest about what it is:
 *   - the populator guarantees the list APPEARS, at boundaries, cached-cheap;
 *   - the transient per-N-calls REMINDER (collect.ts step 5a, teammate-worker
 *     step 3) is what makes it CURRENT mid-task, and it is a note so it never
 *     enters the cached prefix;
 *   - and `recap` is the checkpoint that folds finished work and re-surfaces the
 *     list — the note below IS that delivery channel, which is why the rewind path
 *     does NOT rebuild the project context (that is licensed at compact()/clear()
 *     only, where the prefix already changes).
 *
 * Note the OPENING rule above still applies: `!done || pinned`. That is NOT the
 * same predicate as `Todo.hasOpenTodo()` (`!done || (pinned && preventStop)`) —
 * a known, recorded inconsistency. It is left explicit at each call site rather
 * than unified: the looser rule is correct where a false positive is harmless
 * (mentioning that a list exists), and the stricter one is correct where the item
 * must be actionable. A shared helper was tried and removed — it had no callers
 * and documented three exceptions instead of removing them.
 *
 * Rendering is deliberately compact and hash-free — the model addresses an item
 * by its `#id` (the one handle `todo_update` / `todo_pin` take), so the 8-char
 * integrity hash would only cost tokens. `Todo.printTodoList()` is the PROMPT
 * renderer (markers, hashes, emoji); this is the folded-state renderer.
 *
 * `undefined`/empty → `''`, so a session with no todos produces a two-part note
 * exactly as before — the section never appears empty.
 *
 * ## Deliberately NOT built (recorded so they are not re-proposed)
 *
 * 1. A `todo_list` TOOL the model calls to refresh the list. REJECTED: this repo
 *    already tried a proactive `checkpoint` tool and it failed for a reason that
 *    generalises — the LLM never knew when to call it (pitfall `c5e0818f`:
 *    "A manual 'checkpoint' tool failed: the LLM never knew to call it. Fix:
 *    passive anchors…"). A tool whose only trigger is the model's own judgement
 *    about its own attention is not a mechanism. Delivery must not depend on the
 *    agent choosing to ask.
 *
 * 2. A PER-TURN injection of the list into the project context. REJECTED: the
 *    project-context populators are frozen between `compact()`/`clear()`
 *    boundaries ON PURPOSE — see `prompt-populators.ts` — because refreshing them
 *    every turn invalidated the provider's prompt-cache prefix on each request.
 *    `collect.ts` states the same rule independently: the list "must NOT be
 *    re-injected as a per-turn REMINDER".
 */
export function formatOpenTodos(
  items: readonly { id: number; name: string; done: boolean; pinned?: boolean; note?: string; preventStop?: string }[] | undefined,
): string {
  const open = (items ?? []).filter((i) => !i.done || i.pinned);
  if (open.length === 0) return '';
  // BOUNDED (review M3). The whole list is re-serialised into a durable tool result
  // whose size is pre-checked against the result threshold; an unbounded section can
  // therefore make a recap PERMANENTLY IMPOSSIBLE once enough long rows accumulate
  // (pinned rows never auto-clear, so it only grows). Truncating here keeps the
  // note writable and says so explicitly, instead of silently failing every recap.
  const shown: string[] = [];
  let used = OPEN_TODOS_HEADING.length + 1;
  let omitted = 0;
  for (const i of open) {
    const marker = i.done ? '[x]' : '[ ]';
    const pin = i.pinned ? ' (pinned)' : '';
    const guard = clampTodoText(i.preventStop);
    const note = clampTodoText(i.note);
    const line = `${marker} #${i.id} ${clampTodoText(i.name) ?? '(unnamed)'}${pin}`
      + `${note ? ` (${note})` : ''}${guard ? ` [preventStop: ${guard}]` : ''}`;
    // CHAR BUDGET, not a row count (round-2 review, major #2). Stop at the budget so
    // the note stays writable regardless of how many maximal rows have accumulated.
    if (used + line.length + 1 > MAX_TODO_SECTION_CHARS) {
      omitted = open.length - shown.length;
      break;
    }
    shown.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    shown.push(`… and ${omitted} more open todo(s) not shown (use \`/todos\` to list all).`);
  }
  return `${OPEN_TODOS_HEADING}\n${shown.join('\n')}`;
}

/**
 * Assemble the note BODY a recap writes into the anchor brief's tool result:
 * three parts, in this order —
 *
 *   1. the bare `[RECAP]` header (plus the quoted anchor brief),
 *   2. the caller's `additionalMessage` (the span summary / the discard note),
 *   3. the OPEN TODO LIST ({@link formatOpenTodos}), when there is one.
 *
 * The LIST COMES LAST because it is the live state the model resumes with; the
 * summary describes work that is already folded, so the checklist is what the
 * next turn should read before choosing its first action.
 *
 * SINGLE SOURCE OF TRUTH — both `Triologue.rewindToLastBrief` (which appends it
 * through `noteWithSummary`) and `Triologue.recapNoteSize` (which sizes it)
 * call this, so a caller's pre-check measures exactly the string the rewrite
 * will store. That is why the todo list is an ARGUMENT here rather than
 * something a caller splices into `additionalMessage` afterwards: a caller
 * that appended it on its own would be sized as if the section did not exist,
 * and an over-size note is written AFTER the truncation (the span is lost with
 * it).
 */
export function buildRecapNote(
  anchorMessage: string,
  additionalMessage: string,
  openTodos?: string,
): string {
  // NO LABEL. The header is the bare `[RECAP]` marker and the body is the
  // model's OWN summary, copied verbatim — recap no longer generates a digest,
  // and the tool takes no label argument to render here.
  const header = [
    '[RECAP]',
    anchorMessage ? `Rewound past the brief: "${anchorMessage}"` : '',
  ].filter(Boolean).join('\n');
  const base = `${header}\n\n${additionalMessage}`;
  const todos = openTodos?.trim() ? openTodos.trim() : '';
  return todos ? `${base}\n\n${todos}` : base;
}

/**
 * Resolve a `recap(target_brief=…)` argument to the brief it names.
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
