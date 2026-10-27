import crypto from 'node:crypto';
import { sanitizeTodoField } from '../../context/shared/todo-render.js';

/**
 * recap-note.ts - The ONE renderer of a folded span's note, plus the helpers
 * that survive the removal of the model-facing anchor line.
 *
 * WHAT A FOLD LOOKS LIKE NOW (before → after):
 *
 *   tool('brief', "OK.")                                    BEFORE the fold
 *   tool('brief', "[RECAP]\n<summary>\n\n### Open todos\n…") AFTER  the fold
 *
 * There is no `[<hash>] ANCHOR — recap(target_brief=…)` line any more. The
 * decision to fold moved OUT of the conversation (docs/loop/auto-recap-plan.md,
 * `recap-signal.ts`): the model never chooses a target, so it must never be
 * shown one. A hash in a tool result would be an affordance pointing at a tool
 * that no longer exists — the exact defect the "manual checkpoint tool" pitfall
 * records.
 *
 * The hash still exists, but as an INTERNAL key (`briefHash`): the summary
 * signal names a span with it, and the audit record quotes it. Nothing the
 * model reads contains it.
 *
 * What remains here is what a note is made of:
 *   - `buildRecapNote`   — the marker, the summary, the open-todo list;
 *   - `noteWithSummary`  — the exact string written into the anchor's result;
 *   - `anchoredNoteLength` — the same string's length, for the size pre-check;
 *   - `formatOpenTodos`  — the live checklist the next turn resumes with.
 */

/**
 * The hash of a brief call — a stable digest of its call id, never a separate
 * registry.
 *
 * INTERNAL ONLY. Its callers are `BriefStackManager.getFoldCandidates` (which
 * hands it to the recap signal) and the audit record written after a fold.
 * Since it is never printed into a tool result, the old "make it look like an
 * address" rationale is gone; what it still has to be is SHORT, STABLE and
 * COLLISION-FREE, because it is the token an out-of-band decider returns and
 * the loop resolves back to a call id.
 *
 * Eight hex chars of the WHOLE id — not a prefix of it. Ids are minted as
 * `brief_<13-digit-ms>_<tail>`, so a prefix cut renders `brief_17` for every
 * brief minted in the same ~1.15-day epoch. `undefined` (a brief whose call id
 * was lost) hashes to '' — never a plausible-looking token naming another brief.
 */
export const BRIEF_HASH_LENGTH = 8;

export function briefHash(callId: string | undefined): string {
  if (!callId) return '';
  return crypto
    .createHash('sha256')
    .update(callId)
    .digest('hex')
    .slice(0, BRIEF_HASH_LENGTH);
}

/**
 * The line a folded span's note opens with — the only structural marker left.
 *
 * It is the note's FIRST line, where the old anchor line used to be, so a
 * model (or a reader that renders `split('\n')[0]`) still sees one structural
 * line above the summary. Unlike the anchor line it names nothing and promises
 * no call: it is a category label, not an address.
 */
export const RECAP_MARKER = '[RECAP]';

/** Heading of the live checklist appended to a note. */
export const OPEN_TODOS_HEADING = '### Open todos';

/**
 * Render the note that replaces the content after a folded brief.
 *
 *   [RECAP]
 *   <summary>
 *
 *   ### Open todos
 *   …
 *
 * THE SUMMARY CARRIES NO ANCHOR QUOTE. The old note echoed the anchor's brief
 * message (`Rewound past the brief: "…"`) because the model needed to know
 * WHICH anchor it had folded to in an addressable stack. It does not address
 * anything now: the summary is simply the state of the world it resumes from.
 * The anchor message survives where it belongs — in the audit record
 * (`Triologue.journalRecapAudit()`, a `recap_audit` transcript record written
 * by the caller; NOT a user-journal record, see transcript.ts).
 *
 * SINGLE SOURCE OF TRUTH — both `rewindToLastBrief` (which appends it through
 * `noteWithSummary`) and `recapNoteSize` (which sizes it) call this, so a
 * caller's pre-check measures exactly the string the rewrite will store. An
 * over-size note is written AFTER the truncation, so a caller that measured
 * anything else would lose the span.
 */
export function buildRecapNote(summary: string, openTodos?: string): string {
  const base = `${RECAP_MARKER}\n\n${summary}`;
  const todos = openTodos?.trim() ? openTodos.trim() : '';
  return todos ? `${base}\n\n${todos}` : base;
}

/**
 * The result a folded brief's tool result is rewritten to — the WHOLE result,
 * not a line glued under a preserved header.
 *
 * PURE OVERWRITE. The previous result (`OK.`, a plan-scope reflection, or an
 * older note) is dropped: the note is the record of the stretch that replaced
 * it, and a second fold at the same brief replaces the summary rather than
 * stacking superseded ones.
 */
export function noteWithSummary(body: string): string {
  return body;
}

/**
 * The exact length {@link noteWithSummary} writes — the number `recapNoteSize`
 * must compare against the result threshold.
 */
export function anchoredNoteLength(body: string): number {
  return body.length;
}

/**
 * Render the complete open/pinned checklist appended to a recap note.
 *
 * The list is never truncated, and fields are never length-clamped. If a
 * complete note cannot fit the configured result-size gate, the caller refuses
 * that fold rather than silently dropping actionable state.
 */
export function formatOpenTodos(
  items: readonly { id: number; name: string; done: boolean; hash?: string; pinned?: boolean; note?: string; preventStop?: string }[] | undefined,
): string {
  const open = (items ?? []).filter((i) => !i.done || i.pinned);
  if (open.length === 0) return '';

  const lines = open.map((i) => {
    const marker = i.done ? '[x]' : '[ ]';
    const pin = i.pinned ? ' (pinned)' : '';
    const name = sanitizeTodoField(i.name) ?? '(unnamed)';
    const note = sanitizeTodoField(i.note);
    const guard = sanitizeTodoField(i.preventStop);
    return `${marker} #${i.id} ${name}${pin}`
      + `${note ? ` (${note})` : ''}${guard ? ` [preventStop: ${guard}]` : ''}`
      + `${i.hash ? ` [hash: ${i.hash}]` : ''}`;
  });
  return `${OPEN_TODOS_HEADING}\n${lines.join('\n')}`;
}

/**
 * Resolve a hash or call id to the candidate it names.
 *
 * INTERNAL ONLY. It replaced the model-facing `recap(target_brief=…)` argument
 * parser: the recap signal names a span by hash, and the loop turns that into
 * the call id it hands to `rewindToLastBrief` as the compare-and-swap token.
 * Nothing in a tool result is parsed by this any more, so it accepts exactly the
 * two spellings the loop produces — the 8-char hash and the full id — and
 * returns null for anything else (the caller then refuses, folding nothing).
 */
export function resolveBriefTarget<T extends { id: string }>(
  target: string,
  candidates: readonly T[],
): T | null {
  const needle = target.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!needle) return null;
  // Exact id first, then the hash (a digest of the whole id).
  const exact = candidates.find((c) => c.id === needle);
  if (exact) return exact;
  const lowered = needle.toLowerCase();
  return candidates.find((c) => briefHash(c.id).toLowerCase() === lowered) ?? null;
}