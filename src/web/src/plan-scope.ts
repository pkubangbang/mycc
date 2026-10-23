/**
 * plan-scope.ts - pure parser for the PLAN-mode "larger scope" reflection.
 *
 * WHY IT LIVES HERE
 * The backend (src/loop/plan-scope.ts) emits the reflection as a labeled log:
 *
 *   brief('info', 'plan-scope', formatPlanScopeForDisplay(note))
 *
 * where the terminal formatter produces a fixed-width ASCII block:
 *
 *   ── plan-scope ──────────────────────────────────
 *   SUBLATE     Serves the ask. One invariant: ...
 *   WRONG PRB   no — the user asked for ...
 *   REVERSIBLE  two-way — ...
 *
 * A terminal can render that as-is; a browser cannot. markdown-it would turn
 * the ASCII rule line into an <hr>, collapse the padEnd() alignment (the
 * label column is whitespace-meaningful), and leave the four checks as one
 * undifferentiated wall of grey text — so a plan-mode user skimming the log
 * cannot see that a step-back reflection even happened.
 *
 * This module re-parses the SAME text into structure the Web UI can render
 * with real layout (PlanScopeCard.vue): one row per check, the check's
 * one-line meaning, and the model's answer. It is a DOM-free, dependency-free
 * function so it is unit-testable in node (see src/tests/web/plan-scope.test.ts)
 * exactly like message-dispatch.ts / collapse-state.ts.
 *
 * CONTRACT: never drop content. The parser must survive every shape the
 * model (or the terminal formatter) can produce:
 *   - the canonical four labelled lines;
 *   - ONE run-on paragraph with all four labels inline (common — the model
 *     does not always honour newlines);
 *   - missing/extra labels; an unlabelled lead-in before the first label;
 *   - no label at all (the terminal formatter passes unlabelled prose
 *     through verbatim, so the Web UI must too).
 * Text that carries no label is returned as `prose` and rendered unchanged.
 */

/** The four escape-hatch checks, in the order the prompt asks for them. */
export const PLAN_SCOPE_LABELS = ['TUNNEL', 'SUBLATE', 'WRONG PRB', 'REVERSIBLE'] as const;

export type PlanScopeLabel = (typeof PLAN_SCOPE_LABELS)[number];

/** The heading line the terminal formatter prefixes to the block. */
const HEADING_LINE_RE = /^[\s]*[─-]{2,}\s*plan-scope\s*[─-]{2,}[\s]*$/gim;

/** Where each label's value ends and the NEXT label begins. Mirrors the
 *  terminal formatter's labels so both surfaces cut the text identically —
 *  `WRONG PRB` is two words.
 *
 *  The separator is OPTIONAL on purpose. The terminal block
 *  (formatPlanScopeForDisplay) prints `LABEL<pad>value` with NO colon, so a
 *  colon-only regex would parse every real reflection as unlabelled prose. A
 *  colon, an em-dash or a hyphen is consumed when present; otherwise the run
 *  of spaces after the label is. Only labels that follow start-of-string or a
 *  non-word character qualify, so "SUBLATE" inside a sentence (or a longer
 *  word) is not mistaken for a label. A recognised separator does NOT need
 *  trailing whitespace — `TUNNEL:` on its own line is a label with an empty
 *  answer (the card renders "（无输出）"), not prose. Whitespace around the
 *  separator is HORIZONTAL ONLY ([ \t]): `\s` would let an empty `TUNNEL:` line
 *  swallow the newline and absorb the next line as its value. Both dashes are
 *  literal characters, never `\uXXXX` escapes: under the `i` flag the engine
 *  case-folds escape hex digits, so `\u2014` silently becomes a different
 *  codepoint. */
const LABEL_RE = /(?:^|[^\w])(TUNNEL|SUBLATE|WRONG PRB|REVERSIBLE)[ \t]*(?:(?::|—|-)[ \t]*|[ \t]+)/gi;

/** One parsed check: the label and the model's (possibly empty) answer. */
export interface PlanScopeCheck {
  label: PlanScopeLabel;
  value: string;
}

/** The parsed reflection. `prose` is set only when no label was found. */
export interface ParsedPlanScope {
  /** Text before the first label (rides above the rows), or '' . */
  leadIn: string;
  checks: PlanScopeCheck[];
  /** Verbatim content when the text carries no recognizable label. */
  prose: string | null;
}

/** Trim whitespace, but keep a terminal sentence period: the values are
 *  prose read by a human, so "…revert the commit." stays punctuated. Only
 *  the SEPARATOR residue left by the label cut (a stray comma/semicolon/colon
 *  or dash) is stripped. The em-dash is a literal char — see LABEL_RE for why
 *  it must not be written as an escape. */
function clean(text: string): string {
  return text
    .replace(/^[\s,;:·—-]+/, '')
    .replace(/(?:[\s,;:·—-]+|\s+\.+)$/, '')
    .trim();
}

/** Collapse the newlines INSIDE one check's value into single spaces — a
 *  check is one row; its answer may have been wrapped in the terminal block. */
function flatten(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Parse a plan-scope log content into structure.
 *
 * Never throws and never loses text: anything before the first label becomes
 * `leadIn`, everything after a label (up to the next label) becomes that
 * check's `value`, and text with no label at all is returned as `prose`.
 */
export function parsePlanScope(content: string): ParsedPlanScope {
  const raw = (content ?? '').replace(HEADING_LINE_RE, '\n').trim();
  if (!raw) return { leadIn: '', checks: [], prose: null };

  const marks: Array<{ label: PlanScopeLabel; at: number; end: number }> = [];
  for (const m of raw.matchAll(LABEL_RE)) {
    // m[0] may start with the one non-word char the lookbehind alternative
    // consumed (e.g. a space before a mid-paragraph label) — skip it so the
    // label's own start index stays correct for slicing.
    const lead = m[0].length - m[0].trimStart().length;
    const at = (m.index ?? 0) + lead;
    marks.push({
      label: m[1].toUpperCase().replace(/\s+/g, ' ') as PlanScopeLabel,
      at,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  if (marks.length === 0) return { leadIn: '', checks: [], prose: raw };

  const leadIn = flatten(clean(raw.slice(0, marks[0].at)));
  const checks = marks.map((mark, i) => {
    const until = i + 1 < marks.length ? marks[i + 1].at : raw.length;
    return { label: mark.label, value: flatten(clean(raw.slice(mark.end, until))) };
  });
  return { leadIn, checks, prose: null };
}

/** True when a labeled log is a plan-scope reflection. The label is the
 *  backend's contract (hook.ts emits exactly 'plan-scope'); kept here so the
 *  component and its tests agree on one literal. */
export const PLAN_SCOPE_LOG_LABEL = 'plan-scope';

/**
 * The one-line meaning shown next to each check label. The card explains the
 * CHECK, not only quotes it — a reader scanning the log has to know what
 * "TUNNEL" and "SUBLATE" are asking without opening the docs.
 */
export const PLAN_SCOPE_HINTS: Record<PlanScopeLabel, string> = {
  TUNNEL: '打破哪条规则能让工作更简单',
  SUBLATE: '两个要求能否归并为一个不变量',
  'WRONG PRB': '如果这个任务从未被提出，还会做吗',
  REVERSIBLE: '这一步是否单向门',
};

/**
 * The model answers each check with a sentinel when there is nothing to say
 * ("none — …", "no — …", "two-way — …"). The card tones those rows neutrally
 * so attention lands on the rows that carry a real finding.
 */
export function isSentinelAnswer(value: string): boolean {
  return /^(none|no|two-way)\b/i.test(value.trim());
}
