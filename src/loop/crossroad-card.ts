/**
 * crossroad-card.ts - DISPLAY CONTRACT for the crossroad ("best-of-three")
 * candidate card.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The crossroad used to be rendered as two independent free-text notes: one
 * markdown string listing the drafted continuations and a second `Resolved: …`
 * note with the winner. The reader had to reconcile two log entries to answer
 * the only question that matters — *of these directions, which one did it take,
 * and what does that one actually say?* — and the previews were character-sliced
 * out of RAW model text, so a newline, a `- ` marker or a ``` fence inside a
 * continuation could split or corrupt the very row meant to preview it.
 *
 * So the crossroad is emitted as ONE STRUCTURED event instead of two sentences:
 *
 *     buildCrossroadCard({ candidates, selectedIndex, resolvedOutcome })
 *         ├─ toCrossroadCardWire()  → the flat payload on the `crossroad` note
 *         └─ formatCrossroadCard()  → its plain-text fallback
 *
 * Rendering is then a VIEW concern (terminal prints `formatCrossroadCard()`;
 * the WebUI renders structured rows, emphasises the winner and collapses the
 * drafts). Previews are derived HERE, at render time — flattened to one line,
 * markdown-inert, ellipsis-truncated only after the flattening — never baked
 * into the source text before truncation.
 *
 * This file is deliberately dependency-free (no chalk, no agentIO, no DOM) so
 * both the lead loop and the browser can share the contract and so it can be
 * unit-tested in the node suite.
 */

/** Maximum rendered preview length (characters) for one candidate. */
export const CROSSROAD_PREVIEW_MAX = 100;

/** One drafted continuation, already safe to display. */
export interface CrossroadCandidateView {
  /** 1-based position in GENERATION order (go forward / backward / synthesize). */
  index: number;
  /** The direction label that produced it (e.g. "go forward"). */
  direction: string;
  /** Single-line, markdown-inert preview (≤ CROSSROAD_PREVIEW_MAX chars). */
  preview: string;
  /** true for the continuation the selector picked. */
  selected: boolean;
}

/** The whole crossroad event, as the display layer needs it. */
export interface CrossroadCard {
  /** How many directions were drafted. */
  drafted: number;
  /** The chosen candidate (1-based), or -1 when the selector could not name one. */
  chosenIndex: number;
  /** Every drafted candidate in GENERATION order — order is an invariant. */
  candidates: CrossroadCandidateView[];
  /**
   * The resolved outcome text (the winning continuation, as it was appended to
   * the response), single-line preview. Empty when the caller has none.
   */
  outcome: string;
}

/** Flattened, markdown-inert, truncated preview of arbitrary model text. */
export function plainPreview(text: string, max: number = CROSSROAD_PREVIEW_MAX): string {
  // 1. FLATTEN FIRST. Newlines would break the numbered row; collapse ANY run
  //    of whitespace (including newlines/tabs) to one space.
  let flat = text.replace(/\s+/g, ' ').trim();

  // 2. MAKE MARKDOWN INERT. A preview is DATA, not a document: `**bold**`,
  //    `` `code` `` and `# heading` inside a continuation must render literally
  //    rather than restyling (or, for an unclosed fence, swallowing) the row.
  flat = flat
    .replace(/`/g, "'")
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '');

  // 3. TRUNCATE LAST, on the flattened string, so the cut can never split a
  //    structural marker (the old order sliced raw text and then hoped).
  if (flat.length > max) {
    flat = `${flat.slice(0, max).trimEnd()}…`;
  }
  return flat;
}

/**
 * Build the display card from a crossroad result.
 *
 * @param args.candidates  - drafted continuations, in GENERATION order
 * @param args.selectedIndex - index of the winner within `candidates` (-1 if unknown)
 * @param args.resolvedOutcome - the winning continuation text (optional)
 * @param args.directionNames - labels aligned with `candidates`; when shorter,
 *   the remaining rows fall back to `option N` (never invented labels).
 */
export function buildCrossroadCard(args: {
  candidates: readonly string[];
  selectedIndex: number;
  resolvedOutcome?: string;
  directionNames?: readonly string[];
}): CrossroadCard {
  const { candidates, selectedIndex, resolvedOutcome, directionNames } = args;
  const chosenIndex = selectedIndex >= 0 && selectedIndex < candidates.length ? selectedIndex : -1;

  return {
    drafted: candidates.length,
    chosenIndex: chosenIndex < 0 ? -1 : chosenIndex + 1,
    candidates: candidates.map((text, i) => ({
      index: i + 1,
      direction: directionNames?.[i] ?? `option ${i + 1}`,
      preview: plainPreview(text),
      selected: i === chosenIndex,
    })),
    outcome: resolvedOutcome ? plainPreview(resolvedOutcome, CROSSROAD_PREVIEW_MAX * 2) : '',
  };
}

/**
 * The PLAIN-TEXT rendering of the card — the terminal fallback, and the `content`
 * of the broadcast note (so a terminal-only or history-only reader still gets
 * the whole picture in one message, in the intended reading order).
 *
 * Layout: title → numbered candidates (winner first-class, marked) → outcome as
 * its own paragraph. Deliberately free of box-drawing and ANSI codes: it must
 * survive being broadcast verbatim to clients that render markdown.
 */
export function formatCrossroadCard(card: CrossroadCard): string {
  const lines: string[] = [];
  const chosen = card.chosenIndex > 0 ? ` — chose #${card.chosenIndex}` : '';
  lines.push(`**🚦 Crossroad** — drafted ${card.drafted} direction${card.drafted === 1 ? '' : 's'}${chosen}:`);
  for (const c of card.candidates) {
    const marker = c.selected ? '✅' : '⬜';
    const name = c.selected ? `**${c.direction}**` : c.direction;
    lines.push(`${c.index}. ${marker} ${name} — ${c.preview}`);
  }
  if (card.outcome) {
    lines.push('');
    lines.push(`**Outcome:** ${card.outcome}`);
  }
  return lines.join('\n');
}

/**
 * The WIRE payload: a flat, JSON-safe object the broadcast layer can attach to
 * the note without the client having to parse markdown back into structure.
 *
 * Kept flat (no nested-only shape) to match the existing card convention
 * (`CardMessage` sends cardId/query/kind at the top level).
 */
export interface CrossroadCardWire {
  /** Present on the wire so the client can branch on it without type guessing. */
  kind: 'crossroad';
  drafted: number;
  chosenIndex: number;
  candidates: Array<{ index: number; direction: string; preview: string; selected: boolean }>;
  /** Resolved outcome preview ('' when absent). */
  outcome: string;
}

/** Convert a card to its wire payload. */
export function toCrossroadCardWire(card: CrossroadCard): CrossroadCardWire {
  return {
    kind: 'crossroad',
    drafted: card.drafted,
    chosenIndex: card.chosenIndex,
    candidates: card.candidates.map((c) => ({
      index: c.index,
      direction: c.direction,
      preview: c.preview,
      selected: c.selected,
    })),
    outcome: card.outcome,
  };
}
