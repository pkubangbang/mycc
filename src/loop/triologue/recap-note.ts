/**
 * recap-note.ts - the brief result's success line and the recap note appended to it.
 *
 * A `brief` result is the durable note that survives a recap. Two writers
 * produce it and they must never drift:
 *
 *   1. the `brief` tool (+ the TOOL-stage plan-scope reflection) — the success
 *      result, "OK." optionally followed by a section;
 *   2. recap's rewind — it REWRITES that result in place with `noteWithSummary()`,
 *      so the collapsed span's summary lives in a TOOL RESULT (where the
 *      conversation still shows the anchor turn) instead of in a synthetic
 *      recap call appended at the end.
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
 * The result a `brief` call answers with before any recap has touched it.
 *
 * The tool appends the sentence period ("OK.") so the result reads as prose when
 * the plan-scope section follows it; the recap note is appended after that same
 * prefix (`noteWithSummary`), so the two writers share one success line.
 */
export const PRISTINE_BRIEF_RESULT = 'OK';

/** Marker opening the note text appended after the success result. */
const NOTE_MARKER = 'Note, a recap has reset the conversation here with summary: ';

/**
 * The section the TOOL stage appends to a brief result in PLAN mode (see
 * src/loop/plan-scope.ts). Defined here, next to the marker, so every known
 * section of a brief result is declared in one place.
 */
export const PLAN_SCOPE_HEADING = 'When thinking on the larger scope';

/** True when `content` is a brief result carrying the plan-scope section. */
export function hasPlanScopeSection(content: string | undefined): boolean {
  return typeof content === 'string' && content.startsWith(`${PRISTINE_BRIEF_RESULT}. ${PLAN_SCOPE_HEADING}`);
}

/**
 * The rewritten brief result: the original success, followed by the note.
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
export function noteWithSummary(body: string): string {
  return `${PRISTINE_BRIEF_RESULT} ${NOTE_MARKER}${body}`;
}
