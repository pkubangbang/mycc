/**
 * triologue/brief-stack.ts - Brief stack + recap (rewind) feature domain
 *
 * Owns the "brief" stack of a conversation: which `brief` round-trip is the
 * current rewind ANCHOR, how the span under it is sliced, and how a recap
 * collapses the history back onto it. Extracted from triologue.ts (Rewind
 * (recap) region); the facade now delegates every public member here with
 * ZERO API change (`getLastBrief`, `rewindToLastBrief`, `recapNoteSize`,
 * `listBriefHashes`).
 *
 * WHY THE STORE IS THE FIRST ARGUMENT (the user's requirement): every rule in
 * this file is a rule about MESSAGES — which assistant records carry a
 * non-synthetic `brief` call (`MessageStore.briefIndices`), where the tool
 * result answering a call sits (`findToolResultIndex`, `firstMessageIndexAfter`),
 * which TRUE-array region a collapse deletes (`sliceFrom`), and where the note
 * is written back (`rewriteToolResult`). The store is therefore the manager's
 * model, not a dependency it consults: the anchor walk, the span slice, the
 * truncation and the in-place rewrite all run through it, and no caller can
 * hand in an index the manager did not resolve itself.
 *
 * WHAT IS *NOT* THE STORE, AND WHY EACH IS A NARROW CALLBACK (`BriefStackDeps`):
 *
 *  - `clearPendingToolCalls` — truncation invalidates every pending call that
 *    lived in the removed span. The pending-tool LEDGER is transport
 *    bookkeeping (assistant tool_calls → tool results), shared with tool(),
 *    agent(), skipPendingTools() and the TP fixer; it is deliberately not part
 *    of MessageStore, and a manager must not reach into the facade's copy.
 *  - `resetWrapUpMark` — after a truncation the wrap-up mark can exceed the new
 *    length, and a later rollback would then do `length = mark` and STRETCH the
 *    array with undefined holes. The mark lives in WrapUpManager (wrap-up.ts),
 *    a separate feature domain.
 *  - `dropDeferredInputs` — the facade buffers note()/user() submissions while
 *    tool_calls are outstanding. A rewound (or rolled-back) span destroys their
 *    referent, so they must be DROPPED, not replayed; the queue is the
 *    facade's, re-entered through its own public producers.
 *  - `emitControl` — the transcript boundary marker ('recap' / 'rollback'). The
 *    journal sink is the facade's `onMessage` option (TriologueOptions); the
 *    manager must not import the facade's option type just to journal.
 *
 * TOKEN RECOUNT IS DELIBERATELY *NOT* A CALLBACK: `recomputeTokenCount()` and
 * `tokenCount` are store methods, so the accounting stays inside the store and
 * the manager only sequences the two.
 *
 * Pattern mirrors triologue/wrap-up.ts and triologue/tp-fix.ts: a deps object
 * bound to the facade's live state via arrow closures, resolved lazily at call
 * time, so a store swap (compact/clear) never leaves a stale reference behind.
 */

import type { Message, ToolCall } from '../../types.js';
import type { MessageStore } from './store.js';
import { readBriefConfidence, readBriefMessage } from './brief.js';
import { anchoredNoteLength, briefHash, buildRecapNote, noteWithSummary, resolveBriefTarget } from './recap-note.js';

/**
 * Everything the brief stack needs that is NOT a MessageStore method.
 * See the file header for why each one is a callback instead of store state.
 */
export interface BriefStackDeps {
  /** Clear the pending-tool ledger (calls in the removed span are now invalid). */
  clearPendingToolCalls: () => void;
  /** Reset the wrap-up mark so a later rollback cannot extend the array. */
  resetWrapUpMark: () => void;
  /** Drop buffered note()/user() submissions whose referent is being removed. */
  dropDeferredInputs: (reason: string) => void;
  /** Journal the truncation boundary ('recap' | 'rollback') to the transcript. */
  emitControl: (event: 'recap' | 'rollback') => void;
}

export class BriefStackManager {
  constructor(
    private readonly store: MessageStore,
    private readonly deps: BriefStackDeps,
  ) {}

  /**
   * The CURRENT anchor: the brief the next recap would rewind to.
   *
   * THE RULE — a brief is an anchor IFF
   *   1. it is NOT synthetic (llm.ts recovery, hook.ts crossroad — boilerplate
   *      messages that would preserve infrastructure noise), and
   *   2. at least one message follows its round-trip (the assistant brief call
   *      AND the tool result answering it).
   *
   *   Rule 2 counts ACTIVITY only: a `recap` round-trip is never activity (the
   *   recap tool either collapses successfully — leaving its anchor's round-trip
   *   last — or fails, producing a plain tool-call error). So a failure
   *   neither arms the previous brief nor joins the next span.
   *
   * Rule 2 is what makes a lone brief a NON-anchor: the newest brief in a live
   * conversation is where that conversation currently stands — the work under
   * way to its result — so there is nothing after it yet to collapse. The
   * moment ANYTHING lands after it — a tool call, a query, or even another
   * brief — it becomes history and anchors. There is deliberately no separate
   * "consumed" marker: a recap leaves the anchor's round-trip last, so rule 2
   * alone makes repeated recaps walk backwards.
   *
   * Consequences (the sequences a real session produces; `t` = any tool):
   *
   *   b1 → t → b2 → t → recap                   → b2
   *   … → recap → recap                         → b1 (the recap left b1's
   *                                               round-trip last, so b2 — now
   *                                               the newest — has nothing
   *                                               after it)
   *   … → recap → t → recap                     → b2 (the tool re-arms b2)
   *   … → recap → b3 → recap                    → b2 (a lone b3 is not yet an
   *                                               anchor, and the b3 message
   *                                               itself is what b2 needs after
   *                                               it)
   *
   * Index of the brief a rewind lands on.
   *
   * NO target — the DEFAULT: the newest real brief the conversation has moved
   * past (rule 2 alone, see the class comment): after a rewind the anchor's
   * round-trip is last, so repeated recaps walk backwards one solidified brief
   * at a time.
   *
   * WITH `target` (recap's `target` argument, e.g. `[234abc]`): the brief that
   * carries that hash (or the full id it is a prefix of). A target is an
   * EXPLICIT request, so it wins over the "not yet solidified" rule — the model
   * may name a brief the conversation has not moved past. What it may NOT name
   * is the last message in the history: there is nothing after it to collapse.
   * Unknown target → -1 (the caller refuses; it must never silently fall back
   * to the default anchor, which would delete a span the model did not choose).
   *
   * `targetRefusal()` tells the two failures apart — `'unknown'` (no brief carries
   * that hash) from `'nothing-after'` (it does, but nothing follows it yet) — so
   * the refusal can say which, and can quote the hashes that DO work.
   */
  private anchorIndexFor(target?: string): number {
    if (target !== undefined && target !== '') {
      const candidate = this.resolveTargetCall(target);
      if (!candidate) return -1;
      // A brief that is the very last message has nothing to collapse.
      return this.hasMessagesAtOrAfterBrief(candidate.index) ? candidate.index : -1;
    }

    const indices = this.store.briefIndices();

    // Newest first; the structural test is the WHOLE rule (rule 2 above), so
    // there is no drop-last shortcut — a newest brief with activity after it
    // must win.
    for (let i = indices.length - 1; i >= 0; i--) {
      if (this.hasMessagesAfterBrief(indices[i])) return indices[i];
    }
    return -1;
  }

  /** The first `brief` call of the assistant message at `index`, if unmarked. */
  private briefCallAt(index: number): ToolCall | null {
    const message = this.store.at(index);
    if (!message || message.synthetic) return null;
    return (message.tool_calls as ToolCall[] | undefined)?.find((tc) => tc.function?.name === 'brief') ?? null;
  }

  /**
   * Every real brief's displayed hash, oldest first.
   *
   * `foldableOnly` applies the EXPLICIT-target rule (`hasMessagesAtOrAfterBrief`)
   * — the set `recap(target_brief=…)` will actually accept. A refusal message MUST pass
   * it: naming a hash the very next call refuses is the same false affordance as
   * a line 1 that advertises a call over an empty span. Without it the list is the
   * raw brief stack (used where "which briefs exist" is the question, not "which
   * can I fold to").
   */
  listBriefHashes(foldableOnly = false): Array<{ hash: string; message: string }> {
    const out: Array<{ hash: string; message: string }> = [];
    for (const index of this.store.briefIndices()) {
      if (foldableOnly && !this.hasMessagesAtOrAfterBrief(index)) continue;
      const call = this.briefCallAt(index);
      if (call) out.push({ hash: briefHash(call.id), message: readBriefMessage(call) });
    }
    return out;
  }

  /**
   * The hashes a `recap(target_brief=…)` can fold to RIGHT NOW, NEWEST FIRST — the
   * `· open:` list rendered into a freshly created brief's result.
   *
   * Uses `hasMessagesAtOrAfterBrief` — the EXPLICIT-target rule
   * (`anchorIndexFor`'s `target` branch) — because that is the only rule the
   * listed hashes answer: a brief with nothing after it is not the default
   * anchor but IS a valid `target`, and leaving it out would advertise less
   * than the tool accepts. The brief being created is automatically excluded:
   * it is the newest message, so nothing follows it.
   *
   * A brief a previous recap folded is gone from `briefIndices()` (the span
   * above it was truncated), so this list cannot name a consumed anchor.
   *
   * Pure read — no truncation, no rewriting, no recap. This is evidence the
   * model sees; the decision remains its own tool call.
   */
  listOpenAnchors(): string[] {
    const out: string[] = [];
    for (const index of this.store.briefIndices()) {
      if (!this.hasMessagesAtOrAfterBrief(index)) continue;
      const call = this.briefCallAt(index);
      if (call) out.push(briefHash(call.id));
    }
    return out.reverse();
  }

  /**
   * The fold candidates an auto-recap signal may choose from, in TIMELY ORDER
   * (oldest → newest).
   *
   * The decision to fold used to belong to the model (`recap(target_brief=…)`);
   * it now belongs to an observer outside the conversation (`recap-signal.ts`),
   * which needs a compact, quantitative view of the stack instead of a list of
   * callable hashes. This is that view, and the ONLY input the signal gets:
   * the hash (an opaque key the loop resolves back to a call id), the brief's
   * message, and the size of the span under it.
   *
   * A candidate is any real brief with at least one message after its
   * round-trip (`hasMessagesAtOrAfterBrief`, the same structural rule the
   * explicit target always used). The newest brief is therefore excluded on
   * its own: nothing follows it yet.
   *
   * `spanMessages` / `spanTokens` describe exactly the region
   * `rewindToLastBrief` would delete (messages after the brief's tool result
   * to the end), so the signal can compare spans and current usage on ONE
   * scale. `spanTokens` is the project-wide `chars / 4` estimate — the same
   * approximation the token threshold uses — and must not diverge from it.
   *
   * Pure read: no truncation, no rewriting, no LLM.
   */
  getFoldCandidates(): Array<{
    hash: string;
    message: string;
    id: string;
    spanMessages: number;
    spanTokens: number;
  }> {
    const out: Array<{
      hash: string;
      message: string;
      id: string;
      spanMessages: number;
      spanTokens: number;
    }> = [];
    for (const index of this.store.briefIndices()) {
      if (!this.hasMessagesAtOrAfterBrief(index)) continue;
      const call = this.briefCallAt(index);
      const id = call?.id ?? '';
      if (!call || !id) continue;
      const resultIdx = this.store.findToolResultIndex(id, index + 1, 'brief');
      const start = (resultIdx >= 0 ? resultIdx : index) + 1;
      const span = this.store.sliceFrom(start);
      const chars = span.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      out.push({
        hash: briefHash(id),
        message: readBriefMessage(call),
        id,
        spanMessages: span.length,
        spanTokens: Math.ceil(chars / 4),
      });
    }
    return out;
  }


  /** The brief a `target` names, whether or not it is foldable yet — null when no
   *  brief carries that hash or id. */
  private resolveTargetCall(target: string): { index: number; call: ToolCall } | null {
    const candidates = this.store.briefIndices()
      .map((index) => {
        const call = this.briefCallAt(index);
        return call ? { index, id: call.id ?? '' } : null;
      })
      .filter((c): c is { index: number; id: string } => c !== null);
    const match = resolveBriefTarget(target, candidates);
    if (!match) return null;
    const call = this.briefCallAt(match.index);
    return call ? { index: match.index, call } : null;
  }

  /**
   * WHY an explicit `target` could not be used — the two cases need different
   * words: the hash names no brief at all, or it names one that has nothing after
   * it yet (every freshly printed anchor, until new work lands below it). Saying
   * "no brief matches" for the second case tells the model its own transcript is
   * wrong.
   *
   * Null when the target IS usable (or when no target was given).
   */
  targetRefusal(target: string | undefined): 'unknown' | 'nothing-after' | null {
    if (!target) return null;
    const candidate = this.resolveTargetCall(target);
    if (!candidate) return 'unknown';
    return this.hasMessagesAtOrAfterBrief(candidate.index) ? null : 'nothing-after';
  }

  /**
   * True when the brief at `index` has at least ONE message after its
   * round-trip — the same structural test as `hasMessagesAfterBrief`, WITHOUT
   * the recap-machinery exemption. Used by an EXPLICIT target, which asks
   * "is there a span under this brief at all", not "has the conversation moved
   * on from it".
   */
  private hasMessagesAtOrAfterBrief(index: number): boolean {
    const call = this.briefCallAt(index);
    const resultIdx = this.store.findToolResultIndex(call?.id, index, 'brief');
    const after = this.store.firstMessageIndexAfter(resultIdx >= 0 ? resultIdx : index);
    return after < this.store.length;
  }

  /**
   * True when any message that counts as ACTIVITY follows the brief round-trip
   * at `index`.
   *
   * The recap tool NEVER produces activity. A recap either collapses (its step
   * 3 truncates everything after the anchor's round-trip and rewrites the
   * anchor's result, so the anchor IS the last thing in the history) or fails
   * (it answers the call with a plain tool-call error and changes nothing).
   * So a `recap` round-trip — the assistant call and the tool result answering
   * it — is the recap machinery talking to itself, never "the conversation
   * moved on".
   *
   * Counting it would let a FAILED recap arm the previous brief as an anchor
   * that the next recap then folds — deleting the user's still-unserved query
   * along with the failure. Skipping it keeps one rule for both outcomes: after
   * a successful recap, rule 3 is satisfied only by real work; after a failed
   * one, the previous anchor state is exactly as it was before the attempt.
   */
  private hasMessagesAfterBrief(index: number): boolean {
    const call = this.store.at(index)?.tool_calls as ToolCall[] | undefined;
    const briefCall = call?.find((tc) => tc.function?.name === 'brief');
    const resultIdx = this.store.findToolResultIndex(briefCall?.id, index);
    const after = this.store.firstMessageIndexAfter(resultIdx >= 0 ? resultIdx : index);
    if (after >= this.store.length) return false;

    const first = this.store.at(after);
    const recapCall = (first?.tool_calls as ToolCall[] | undefined)?.find((tc) => tc.function?.name === 'recap');
    if (first?.role === 'assistant' && recapCall) {
      // Resume after the recap's own round-trip: the assistant call and the
      // tool result answering IT (whatever it says — success or error).
      const ownResult = this.store.findToolResultIndex(recapCall.id, after);
      const next = this.store.firstMessageIndexAfter(ownResult >= 0 ? ownResult : after);
      return next < this.store.length;
    }
    return true;
  }

  /**
   * Resolve the rewind anchor ONCE for every caller and snapshot it.
   *
   * getLastBrief(), rewindToLastBrief() and recapNoteSize() must agree on four
   * rules — which brief is "last" (the synthetic predicate lives in the store),
   * which tool_calls entry counts (name === 'brief'), which brief owns the
   * call (the FIRST one, if a message batches several), and how its message is
   * read. Three hand-copied versions of that sequence is one edit away from the
   * size pre-check measuring a string the append never produces — which is
   * exactly the round-2 bug in a new costume.
   *
   * Everything downstream reads from THIS snapshot: the caller sizes the note
   * with `recapNoteSize(…)` and then rewinds with `rewindToLastBrief(…)`, and
   * both must describe the same anchor the span was sliced from. Re-deriving
   * the anchor independently in each call is how a span and a truncation point
   * can disagree (the span starts after the anchor's round-trip, the truncation
   * keeps up to the anchor's tool result — two hand-copied answers to "where
   * does the round-trip end").
   *
   * `target` (optional) picks the brief by its displayed hash instead of the
   * newest solidified one — see anchorIndexFor.
   *
   * Returns null when there is no anchor, when a `target` names no brief, when
   * the anchor has no tool result answering it (an orphan brief cannot be
   * rewound — a recap has nowhere to write its note; it is reported as "no
   * anchor" here so the caller refuses before spending two LLM forks), or when
   * `expectedBriefCallId` no longer matches it.
   *
   * The indexes are truncation details that must not leave this manager: the
   * facade only ever sees the opaque `id` / `hash` from getLastBrief().
   */
  private resolveAnchor(
    expectedBriefCallId?: string,
    target?: string,
  ): { index: number; resultIndex: number; call: ToolCall; anchorMessage: string; id: string } | null {
    const index = this.anchorIndexFor(target);
    if (index < 0) return null;

    const anchor = this.store.at(index);
    // The store decides eligibility at the MESSAGE level (Message.synthetic),
    // so a message reaching us is already a real anchor: quote its first brief
    // call. Keeping a per-call filter here would be a second, divergent rule.
    const call = (anchor?.tool_calls as ToolCall[] | undefined)?.find((tc) => tc.function?.name === 'brief');
    if (!call) return null; // defensive: anchor vanished between scan and read

    // The tool result answering THIS call, searched from the anchor on (not
    // from index 0 — a replayed call id must not bind the anchor to an older
    // answer in the span). The TOOL NAME must match too, exactly as in
    // hasMessagesAfterBrief: a provider call id is unique only within a turn,
    // so a reused id must not turn another tool's result into this brief's
    // result. This is the path that TRUNCATES and REWRITES, so a wrong match
    // here rewrites an unrelated result and strands the brief's own tool_call.
    const resultIndex = this.store.findToolResultIndex(call.id, index + 1, 'brief');
    // An orphan brief (no result) is not a legal anchor: there is no message to
    // write the note into, and truncating would strand the assistant's
    // tool_calls. Refuse here, once, before any work is done.
    if (resultIndex < 0) return null;

    // TOCTOU guard: the caller peeked, then awaited the forks (10-60s of LLM
    // time) during which a new brief may have landed. The re-scan above always
    // yields a VALID current index, but it cannot tell whether that is still the
    // anchor the caller summarized. If it moved, truncating would delete a span
    // that was never summarized — refuse, having modified nothing.
    //
    // The token is the brief's tool-call id: `tool = brief && id = x` is what
    // makes a message an anchor, so the id is the honest identity, and it is the
    // one value that survives a rebuilt/replayed store — an array index would
    // accept a different brief occupying the same slot. It is NOT a locator:
    // the anchor is found by the walk-back above; this only answers "still the
    // same brief?".
    const id = call.id ?? '';
    if (expectedBriefCallId !== undefined && id !== expectedBriefCallId) {
      return null;
    }

    return { index, resultIndex, call, anchorMessage: readBriefMessage(call), id };
  }

  /**
   * Peek at the rewind anchor: the newest REAL `brief` that the conversation
   * has already moved past (see currentAnchorIndex for the exact rule) —
   * or, when `target` is given, the brief carrying that hash.
   *
   * Every REAL brief marks a point the conversation can collapse back to, so its
   * `message` is what survives a recap. A brief is eligible by default only once
   * something follows its round-trip — the newest brief is where the
   * conversation currently stands, so it is not yet a boundary. Incidental
   * infrastructure briefs (empty-output recovery, crossroad) are skipped —
   * see MessageStore.briefIndices. Returns null when the history holds no
   * eligible brief (a fresh session, a lone trailing brief, or a transcript
   * restored mid-span), or when `target` names no brief.
   *
   * The array index is NOT returned. `id` is an opaque fingerprint that a
   * caller may carry across an await and hand back to rewindToLastBrief, which
   * re-derives the anchor and refuses to truncate if it moved.
   *
   * `span` is a copy of the messages from just after the brief round-trip
   * (assistant call + its tool result) to the end — exactly the region a
   * rewind deletes, and therefore the only region worth summarizing.
   */
  getLastBrief(target?: string): {
    message: string;
    confidence?: number;
    /** The anchor brief's displayed hash (see recap-note.ts briefHash). */
    hash: string;
    /** The anchor brief's call id — the token to hand back to rewindToLastBrief. */
    id: string;
    span: Message[];
  } | null {
    const resolved = this.resolveAnchor(undefined, target);
    if (!resolved) return null;
    const { call, anchorMessage: message, resultIndex, id } = resolved;

    // Anchor pair = assistant brief call + the tool result answering it.
    // Start after the RESULT — identified by its call id, not by "the next
    // message happens to be a tool", which would swallow an unrelated tool
    // result that legitimately sits right after the brief. `resultIndex` comes
    // from the same resolution rewindToLastBrief uses, so the span's start and
    // the truncation point cannot disagree.
    const start = resultIndex + 1;

    const confidence = readBriefConfidence(call);

    // Slice the TRUE array, not getRaw(): `start` is a true-array index, and
    // getRaw() filters sparse holes, so its indices shift left by the number of
    // holes before the anchor. Slicing the filtered copy would either include
    // the anchor's own brief pair or (with enough holes) yield an empty span and
    // a bogus "already at the compaction boundary" refusal. sliceFrom keeps the
    // same hole-safety for consumers.
    const span = this.store.sliceFrom(start);

    return { message, confidence, hash: briefHash(id), id, span };
  }

  /**
   * Collapse the conversation back to a `brief` (the rewind primitive behind
   * recap): the newest solidified one, or the one `target` names.
   *
   * Steps, in order:
   *   1. re-scan for the anchor — never accept an index from the caller
   *   2. capture the anchor's `message` BEFORE truncation (its pair is deleted)
   *   3. truncate at the anchor's assistant message (truncateAndRecount: keeps
   *      the ledger/journal/token accounting in one place)
   *   4. reset the wrap-up mark — a stale mark greater than the new length
   *      would make a later rollback do `messages.length = mark` and EXTEND
   *      the array with holes
   *   5. rewrite the anchor's tool RESULT in place with the note (pure
   *      overwrite — a previous note is dropped), recounting tokens
   *
   * The summary does NOT get a turn of its own:
   *
   *   assistant('', [brief("BRIEF TWO", 7)]) → tool('brief', "OK.")          BEFORE
   *   assistant('', [brief("BRIEF TWO", 7)]) → tool('brief', "[RECAP]
   *       <span summary> …")                                                  AFTER
   *
   * so the history still ends on role:'tool' — the anchor's own result — the
   * same TP-parity handoff to the next real agent() as before. The result is a
   * PURE OVERWRITE: the note is the whole content, because nothing addresses a
   * brief by a printed hash any more (the fold is decided outside the
   * conversation — see recap-signal.ts).
   *
   * REWIND-BY-BRIEF (no target): the rewind leaves the anchor's round-trip last,
   * and the last brief of any kind is never an anchor, so the next recap moves to
   * the brief before — unless new activity lands after the anchor, which re-arms
   * it.
   *
   * Returns null when there is no brief to rewind to (nothing is modified).
   */
  rewindToLastBrief(
    additionalMessage: string,
    expectedBriefCallId?: string,
    target?: string,
    openTodos?: string,
  ): { anchorMessage: string; tokensBefore: number; tokensAfter: number } | null {
    // One resolution for every caller (see resolveAnchor) — including the
    // TOCTOU refusal, the message read that tolerates a string-shaped
    // `arguments`, and the tool-result index. Nothing below re-derives either
    // the anchor or its result index independently.
    const resolved = this.resolveAnchor(expectedBriefCallId, target);
    if (!resolved) return null;
    const { call, anchorMessage, resultIndex } = resolved;
    const tokensBefore = this.store.tokenCount;

    this.truncateAndRecount(resultIndex + 1, 'recap');
    this.deps.resetWrapUpMark();

    // Written at the RESOLVED occurrence, not the first one bearing this call
    // id: ids are unique only within a turn, so two briefs may share one, and a
    // search from 0 would rewrite the older brief's result instead.
    //
    // The lower bound MUST be `resultIndex` — the search is INCLUSIVE of
    // `fromIndex`. After `truncateAndRecount(resultIndex + 1)` the array holds
    // indices 0..resultIndex, so `resultIndex + 1` would start past the end,
    // match nothing, and return false AFTER the span was already deleted (the
    // caller would report "anchor moved" while the summary was lost).
    // PURE OVERWRITE: the note replaces the whole result. There is no first line
    // to preserve — a brief result is a plain `OK.` now, and a SECOND fold at the
    // same brief must replace the previous note, not stack under it.
    const rewritten = this.store.rewriteToolResult(
      call.id,
      noteWithSummary(buildRecapNote(additionalMessage, openTodos)),
      resultIndex,
    );
    if (!rewritten) return null; // defensive: the result vanished in truncation
    this.store.recomputeTokenCount();

    return { anchorMessage, tokensBefore, tokensAfter: this.store.tokenCount };
  }

  /**
   * The exact length `rewindToLastBrief` writes into the anchor's tool result —
   * anchor line 1, the note marker and the body.
   *
   * Returned so a caller CAN size-check BEFORE mutating anything. Checking the
   * bare summary under-measures by the header (description + quoted anchor) AND
   * by line 1 (which the rewind keeps), and since the rewrite happens AFTER the
   * truncation, an under-measure loses the span with the note unrecorded.
   *
   * `openTodos` is the recap note's third part (see formatOpenTodos). It MUST be
   * the same string handed to rewindToLastBrief — the section is part of the
   * note, so measuring without it under-measures by the whole checklist.
   */
  recapNoteSize(
    additionalMessage: string,
    expectedBriefCallId?: string,
    target?: string,
    openTodos?: string,
  ): number | null {
    // null when the anchor moved — the rewind will refuse for the same reason.
    const resolved = this.resolveAnchor(expectedBriefCallId, target);
    if (!resolved) return null;
    const body = buildRecapNote(additionalMessage, openTodos);
    // ONE rule with rewindToLastBrief: the rewind writes `noteWithSummary(body)`,
    // and the note is the whole result (pure overwrite), so this is the exact
    // length that will be stored.
    return anchoredNoteLength(noteWithSummary(body));
  }

  /**
   * Truncate the message store to `index` (exclusive of later messages),
   * recalculate the token count from the kept messages, and clear the
   * pending tool ledger (any pending calls from the removed span are now
   * invalid). Used by recap span removal and wrap-up rollback. Journals a
   * control event ('recap' or 'rollback') so the transcript carries the
   * boundary marker — replay keeps the durable full history (markers do not
   * cut the collated view), but observers can see exactly where the live
   * context was truncated.
   *
   * SHARED PRIMITIVE: the recap path above and the facade's rollbackWrapUp()
   * both truncate; they must do it identically (store + token recount + ledger
   * + deferred inputs + journal), so there is exactly one implementation and it
   * lives here, next to the store it mutates.
   */
  truncateAndRecount(startIndex: number, event: 'recap' | 'rollback' = 'recap'): void {
    this.store.truncateTo(startIndex);
    this.store.recomputeTokenCount();
    this.deps.clearPendingToolCalls();
    // Recap/rollback discard messages, so a deferred submission's referent may
    // be gone — drop it rather than replay into a truncated context.
    this.deps.dropDeferredInputs(`truncateAndRecount(${event})`);
    this.deps.emitControl(event);
  }
}
