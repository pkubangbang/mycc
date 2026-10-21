/**
 * recap-note.ts - The ONE way to build a brief/recap tool-result note.
 *
 * A `brief` result is not just "OK": it is the durable *note* that survives a
 * recap. Two writers produce that note's text and they must never drift:
 *
 *   1. the `brief` tool handler — the pristine success result ("OK");
 *   2. recap's rewind — it REWRITES the anchor brief's result in place with
 *      `noteWithSummary()`, so the collapsed span's summary lives in a TOOL
 *      RESULT (where the conversation still shows the anchor turn) instead of
 *      in a synthetic recap call appended at the end.
 *
 * The rewritten result is what marks the anchor as CONSUMED: a pristine result
 * means "this brief still anchors", a noted result means "a recap already
 * rewound here" (see Triologue.currentAnchorIndex). That is why the two
 * functions are defined side by side in this module — the marker and the note
 * are the same string.
 */

/** The result a `brief` call answers with before any recap has touched it. */
export const PRISTINE_BRIEF_RESULT = 'OK';

/** Marker opening the note text appended after the pristine success. */
const NOTE_MARKER = 'Note, a recap has reset the conversation here with summary: ';

/**
 * True when `content` is still the untouched success result — i.e. the brief
 * it answers is an eligible rewind anchor.
 */
export function isPristineBriefResult(content: string | undefined): boolean {
  return content === PRISTINE_BRIEF_RESULT;
}

/**
 * The rewritten brief result: the original success, followed by the note.
 *
 * PURE OVERWRITE — the previous note (if any) is dropped. A second recap at the
 * same anchor replaces the summary rather than stacking summaries, so the
 * history never carries a chain of superseded notes.
 *
 * The body is emitted verbatim after the marker. The caller composes it (see
 * triologue.ts buildRecapNote) and may wrap it in JSON (`{"summary": "..."}`)
 * exactly as the user's example shows — this module deliberately does not
 * re-encode it.
 */
export function noteWithSummary(body: string): string {
  return `${PRISTINE_BRIEF_RESULT} ${NOTE_MARKER}${body}`;
}

/**
 * Recover the note body from a rewritten result — the region the size
 * pre-check measures. Returns null when the result is still pristine.
 */
export function readNoteBody(content: string | undefined): string | null {
  if (content === undefined || isPristineBriefResult(content)) return null;
  const prefix = `${PRISTINE_BRIEF_RESULT} ${NOTE_MARKER}`;
  return content.startsWith(prefix) ? content.slice(prefix.length) : content;
}
