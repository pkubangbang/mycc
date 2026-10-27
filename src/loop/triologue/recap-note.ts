import crypto from 'node:crypto';

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
 * (`Triologue.submitUser(…, 'steer')`, written by the caller).
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
 * Per-row text budget for the open-todo section (mirrors serve-todos' MAX_TEXT_LEN).
 */
const MAX_TODO_TEXT_LEN = 500;

/**
 * Total character budget for the rendered section.
 *
 * DERIVED FROM THE GATE IT PROTECTS, not a row count: 40 rows × 3 fields × 500
 * chars ≈ 61 500 chars, against a default `getResultThreshold()` of 50 000 — a
 * session with enough pinned, maximal-note rows made EVERY fold permanently
 * refused. Kept a little under the threshold to leave room for the marker and
 * the summary; `recapNoteSize` remains the authoritative final check.
 */
const MAX_TODO_SECTION_CHARS = 20_000;

/** Flatten + clamp one free-form field so it cannot forge note structure. */
function clampTodoText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Collapse every line break and control char: a name containing "\n### "
  // would otherwise forge a section heading inside a durable note the model
  // reads as authoritative state.
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > MAX_TODO_TEXT_LEN ? `${flat.slice(0, MAX_TODO_TEXT_LEN)}…` : flat;
}

/**
 * Render the open-todo section appended to a note.
 *
 * The checklist lives OUTSIDE the transcript (in the todo module), so without
 * this section a fold would resume the model with no record of what it had
 * promised to keep doing. This is now the ONLY delivery channel for the list —
 * the fold happens with no model involvement, so the note must carry it.
 *
 * OPENING RULE: `!done || pinned` — deliberately NOT the same predicate as
 * `Todo.hasOpenTodo()` (`!done || (pinned && preventStop)`). The looser rule is
 * correct where a false positive is harmless (mentioning that a todo exists);
 * the stricter one is correct where the item must be actionable. Recorded as a
 * known inconsistency, left explicit at each call site.
 *
 * Rendering is compact and HASH-FREE: the model addresses an item by its `#id`
 * (the one handle `todo_update` / `todo_update` take), so the 8-char integrity
 * hash would only cost tokens. `Todo.printTodoList()` is the PROMPT renderer;
 * this is the folded-state renderer.
 *
 * `undefined`/empty → `''`, so a session with no todos produces a two-part note
 * (marker + summary) and the section never appears empty.
 *
 * ## Deliberately NOT built (recorded so they are not re-proposed)
 *
 * 1. A `todo_list` TOOL the model calls to refresh the list. REJECTED: this
 *    repo already tried a proactive `checkpoint` tool and it failed for a
 *    reason that generalises — the LLM never knew when to call it (pitfall
 *    `c5e0818f`). Delivery must not depend on the agent choosing to ask.
 * 2. A PER-TURN injection of the list into the project context. REJECTED: the
 *    project-context populators are frozen between `compact()`/`clear()`
 *    boundaries ON PURPOSE, because refreshing them every turn invalidated the
 *    provider's prompt-cache prefix on each request.
 */
export function formatOpenTodos(
  items: readonly { id: number; name: string; done: boolean; pinned?: boolean; note?: string; preventStop?: string }[] | undefined,
): string {
  const open = (items ?? []).filter((i) => !i.done || i.pinned);
  if (open.length === 0) return '';
  // BOUNDED: the whole list is re-serialised into a durable tool result whose
  // size is pre-checked against the result threshold, so an unbounded section
  // can make a fold PERMANENTLY IMPOSSIBLE once enough long rows accumulate
  // (pinned rows never auto-clear, so it only grows). Truncating here keeps the
  // note writable and says so explicitly.
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
    // CHAR BUDGET, not a row count: stop at the budget so the note stays
    // writable regardless of how many maximal rows have accumulated.
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
 * The plan-scope section heading, still recognised in a brief result.
 *
 * `hasPlanScopeSection` is used by the plan-scope fork to avoid answering the
 * same brief twice; the heading itself is unchanged.
 */
export const PLAN_SCOPE_HEADING = 'When thinking on the larger scope';

/** True when a brief result already carries the plan-scope reflection. */
export function hasPlanScopeSection(content: string | undefined): boolean {
  if (typeof content !== 'string') return false;
  return content.includes(PLAN_SCOPE_HEADING);
}

/**
 * The hash a tool result used to start with (`[<hash>] …`), or null.
 *
 * KEPT FOR THE WEB/SERVE PROJECTION'S MESSAGE KEYS, which prefix a brief's
 * message with a stable token. It no longer reads anything the model writes or
 * that the rewind produces — brief results are plain `OK.` and notes open with
 * `[RECAP]` — so it returns null for both.
 */
export function hashOf(content: string | undefined): string | null {
  if (typeof content !== 'string' || !content.startsWith('[')) return null;
  const close = content.indexOf(']');
  if (close <= 1) return null;
  const candidate = content.slice(1, close);
  // A note's marker is a WORD, not a hex hash: `[RECAP]` must not read as one.
  return /^[0-9a-f]{6,}$/i.test(candidate) ? candidate : null;
}

/** Message with a leading `[<hash>] ` / `[RECAP]` marker removed, if any. */
export function stripHashPrefix(content: string): string {
  if (typeof content !== 'string' || !content.startsWith('[')) return content;
  const close = content.indexOf(']');
  if (close <= 1) return content;
  // A marker word (`[RECAP]`) is not a hash prefix: it is content, and the
  // note's opener must survive for a reader that renders the first line.
  if (!hashOf(content)) return content;
  return content.startsWith('] ', close) ? content.slice(close + 2) : content.slice(close + 1);
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