/**
 * fold-notes.ts - read-time projection that elides stale NUDGE notes
 *
 * INVARIANT (docs/loop/note-taxonomy.md §2):
 *   Write by appending only; fold at read time by `category + staleness`.
 *
 * This module NEVER mutates history. It returns a new array whose stale NUDGE
 * rows are replaced by a fixed placeholder — same index, same role, same
 * count, so the provider-visible structure is what it would have been without
 * folding, except for note content. Consequences:
 *
 *   - Triologue parity (TP) cannot be affected: role sequences are unchanged.
 *   - The journal is untouched, so transcript restore stays consistent.
 *   - The compaction focus prefix (compact.ts takes it from getFullMessages())
 *     is identical on both sides of a fold instead of being invalidated by a
 *     retroactive deletion.
 *
 * WHERE THE CATEGORY COMES FROM
 *   `Message` carries no category field. The category is baked into the
 *   journaled content by note() (`[${category}] ${message}`), which is the
 *   durable form — a reloaded session folds identically with no in-memory
 *   provenance to reconstruct. Prefix matching therefore reads the same source
 *   of truth the provider sees.
 *
 * TEAMMATES ARE *NOT* STRUCTURALLY EXCLUDED - READ THIS
 *   An earlier draft claimed teammates could not acquire the fold because
 *   TriologueLite "has its own message array and never calls into
 *   MessageStore". That claim is FALSE and was corrected after review:
 *   triologue-lite.ts imports MessageStore (:41) and owns one (:61), its note()
 *   delegates into it (:297), and its getMessages() returns
 *   store.getFullMessages() (:520). A teammate worker therefore DOES run this
 *   projection.
 *
 *   What actually keeps the fold inert for teammates today is narrower and
 *   weaker: teammate producers still emit 'REMINDER', never 'NUDGE'
 *   (teammate-worker.ts:399/411/432/581/595/611/794). There is no isLead guard
 *   behind that. If a teammate nudge is ever migrated to 'NUDGE', folding turns
 *   on there automatically - decide deliberately, do not assume lead-only.
 *
 * ONLY 'NUDGE' IS FOLDABLE
 *   Steering, uploads, mail, hints, interrupts and serve-state transitions are
 *   events: no later COLLECT can reproduce them, so dropping one destroys
 *   information. See docs/loop/note-taxonomy.md §3.
 *
 * WHY NOT "keep the last one" (a successor rule) - CONSIDERED AND REJECTED
 *   Requiring a younger surviving NUDGE would make "superseded" literally true,
 *   but it permanently retains the last nudge of each kind, and for two of the
 *   four producers that last one is never replaced: the team snapshot stops
 *   once printTeam() returns 'No teammates.' (collect.ts:165) and the worktree
 *   nudge stops once the worktrees are removed (collect.ts:350-358). Those
 *   rows would sit verbatim for the whole compaction window - and they would be
 *   FALSE, not merely stale ("Worktrees present: ..." after `git worktree
 *   remove`). A standing false premise the model can act on is worse than a
 *   nag that stops nagging, and §5 forbids folded rows from carrying original
 *   content at all. So: plain staleness, neutral wording.
 *
 * @module loop/triologue/fold-notes
 */

import type { Message } from '../../types.js';

/**
 * How many `assistant` rows must appear AFTER a note before it is folded.
 *
 * 1 = "anything injected before the previous LLM call is folded"; only the
 * current LLM call's nudges are kept in full. A larger value keeps the last nudge
 * visible for another round, but it also moves the first divergent message
 * further back in the outbound prefix, which costs more prompt-cache re-prefill
 * on every call. Keep this at 1 unless you have measured that cost.
 */
export const STALE_ASSISTANT_ROWS = 1;

/**
 * Placeholder that replaces a folded note's content.
 *
 * Fixed text: no original content, no imperative, no unearned authorization to
 * proceed — and deliberately no claim that a fresh copy exists. An earlier
 * wording ("superseded by a later nudge") asserted a successor that throttled
 * producers do not guarantee (todo 3 passes, brief 5, worktree 5), which could
 * let the model skip a still-live obligation. Neutral wording survives any
 * future change to the rule; an assertion does not.
 *
 * The leading `[NUDGE] ` is load-bearing beyond display: hint-round.ts filters
 * the analyzer's input on `^\[(?:NUDGE|REMINDER|WRAP_UP)\]`. Rewording the
 * prefix would silently let elided content reach the analyzer - keep it.
 */
export const FOLDED_NUDGE_TEXT = '[NUDGE] (earlier nudge — content elided)';

/**
 * An `assistant` row is an LLM-call boundary: note() defers whenever
 * `ledger.size > 0` (triologue.ts / triologue-lite.ts), so a user-role note can
 * never be interposed between an assistant's tool_calls and their results.
 *
 * KNOWN LIMITATION: synthetic assistant rows inserted by TpAutoFixer bridges
 * (note_after_tool / tool_no_assistant) also count here, so a nudge can reach
 * staleness 1 within the same pass it was injected in: a synthetic bridge row
 * is not a real LLM call (empty content; any tool_calls on it are synthetic —
 * tp-fix.ts injects a bare row for note_after_tool and a synthetic-id row for
 * tool_no_assistant), so the boundary falls inside the pass, not at its edge.
 * A test pins the behaviour.
 *
 * VOCABULARY: "pass" is the right word exactly here, where the claim is about
 * lying INSIDE a COLLECT cycle. Everywhere else in this module the unit is one
 * LLM call. Do not normalise this one to "call" - that would make it false.
 */
function isBoundary(m: Message | undefined | null): boolean {
  return !!m && typeof m === 'object' && (m as Message).role === 'assistant';
}

/**
 * A note row carrying the NUDGE category.
 *
 * Two guards, both required:
 *   - the trailing space: note() emits `[NUDGE] `, so a user writing
 *     "[NUDGE]-ish prose" or a nested mention cannot match;
 *   - `user_origin !== true`: a genuine human submission must never be elided,
 *     even if it happens to start with the prefix. serve-history.ts:352 uses
 *     this same marker to tell injected notes from real user rows.
 */
function isNudge(m: Message | undefined | null): boolean {
  if (!m || typeof m !== 'object') return false;
  const msg = m as Message;
  if (msg.role !== 'user') return false;
  if ((msg as Message & { user_origin?: boolean }).user_origin === true) return false;
  if (typeof msg.content !== 'string') return false;
  return msg.content.startsWith('[NUDGE] ');
}

/**
 * Return a projection of `messages` in which every NUDGE older than
 * STALE_ASSISTANT_ROWS assistant rows has its content replaced by
 * FOLDED_NUDGE_TEXT.
 *
 * Guarantees: same length, same index/role sequence, input array never mutated.
 * When nothing folds, the input array is returned as-is (no allocation).
 * Idempotent: re-folding an already-folded array changes nothing.
 *
 * Cost: one backward pass. Walking right-to-left means the counter
 * `assistantRowsToRight` already holds the note's staleness when we reach it.
 */
export function foldStaleNudges(messages: readonly Message[]): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages as Message[];

  let assistantRowsToRight = 0;
  let out: Message[] | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];

    if (isNudge(m)) {
      if (assistantRowsToRight >= STALE_ASSISTANT_ROWS) {
        // First fold — take the copy lazily so a no-op call allocates nothing.
        if (!out) out = messages.slice() as Message[];
        out[i] = { ...(m as Message), content: FOLDED_NUDGE_TEXT } as Message;
      }
      continue;
    }

    if (isBoundary(m)) assistantRowsToRight++;
  }

  return out ?? (messages as Message[]);
}
