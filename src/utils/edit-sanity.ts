/**
 * edit-sanity.ts - post-edit duplication sanity check
 *
 * `edit_file` replaces a single, unique `old_text` span. That is a mechanical
 * operation, so the tool can always "verify" its own write: old_text is gone,
 * new_text is present. The failure this module addresses is orthogonal — the
 * LLM's `new_text` was constructed badly, typically because it re-included
 * text that already bordered the replaced region instead of replacing it.
 * With A,B,C on three lines and the intent "change B to D", the observed
 * results are:
 *
 *   AADC  old_text="B", new_text="A\nD"   (re-included the PRECEDING line)
 *   ADCC  old_text="B", new_text="D\nC"   (re-included the FOLLOWING line)
 *   ABDC  old_text="B", new_text="B\nD"   (anchor kept → pure insertion)
 *
 * AADC/ADCC leave two identical adjacent lines behind, and ABDC keeps
 * old_text verbatim inside new_text. Both are cheap, local observables.
 *
 * Design constraints (deliberate):
 *
 *  - SPAN-LOCAL, REPORT-NOT-REPAIR. Nothing outside the edited span is ever
 *    blamed, and nothing is rolled back or failed: duplication is sometimes
 *    intended, so the caller appends a warning to an otherwise successful
 *    result.
 *  - LINE SHAPE, NOT LINE TEXT. The tool has no language model and only the
 *    before/after strings; this module never tries to judge whether the code
 *    is "right", only whether the line SHAPE looks like a copy-paste seam.
 *  - The warning text MUST NOT contain the substrings isErrorResult() in
 *    src/loop/states/tool.ts matches ("not found", "does not exist",
 *    "no such file", "permission denied", "enoent", "eacces", "eperm"):
 *    those are matched case-insensitively anywhere in the result, so such a
 *    phrase would bump the confusion index for a SUCCESSFUL edit.
 *  - Known blind spot, stated rather than pretended: replacing the WRONG
 *    unique line (`old="B"`, `new="D"` applied to a different "B") yields a
 *    result lexically identical to a correct edit. No amount of before/after
 *    analysis can recover the LLM's intent there.
 */

/** Which shape anomaly a finding describes. */
export type SanityKind = 'adjacent-duplicate' | 'anchor-retained';

/** One shape anomaly found in the post-edit content. */
export interface SanityFinding {
  kind: SanityKind;
  /** The offending line text (trimmed), for `adjacent-duplicate`. */
  line?: string;
  /** Human/LLM-facing one-liner. */
  message: string;
}

/** Inputs for {@link checkEditSanity}: all strings LF-normalized, BOM-stripped. */
export interface EditSanityInput {
  /** File content BEFORE the edit. */
  before: string;
  /** File content AFTER the edit (as written to disk). */
  after: string;
  /** The literal old_text the caller asked to replace. */
  oldText: string;
  /** The literal new_text the caller supplied. */
  newText: string;
}

/**
 * Skip the check on very large files. The scan is linear but runs on every
 * edit; above this size the extra allocation is not worth it, and a huge file
 * is unlikely to be edited by a single anchored replacement anyway.
 */
const MAX_SCAN_CHARS = 2_000_000;

/**
 * Minimum number of non-whitespace characters in `old_text` for the
 * `anchor-retained` rule to speak. A two-character anchor ("x", "//") kept
 * inside new_text says nothing useful.
 */
const MIN_ANCHOR_CHARS = 8;

/** Longest echoed line reported back to the LLM before truncation. */
const MAX_LINE_CHARS = 120;

/**
 * Lines whose shape carries no duplication signal: too short to identify
 * anything, or pure punctuation (closing braces, brackets, code fences,
 * separators). Without this guard, one extra `}` under a nested block — or a
 * duplicated `---` under a heading — would fire on nearly every edit.
 */
function isTrivialLine(trimmed: string): boolean {
  if (trimmed.length <= 1) return true;
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

/** Trim end (keeps leading indentation out of the comparison key). */
function shapeKey(line: string): string {
  return line.trimEnd();
}

/**
 * Count adjacent identical line pairs (`L,L`) per line shape.
 *
 * The counts are what matter, not the positions: an edit only ADDS a pair, it
 * never rewrites the rest of the file, so `after[L] > before[L]` means this
 * edit introduced the duplication.
 */
function adjacentPairCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const key = shapeKey(lines[i]);
    if (key === shapeKey(lines[i - 1]) && !isTrivialLine(key.trim())) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Truncate a line for display, marking the truncation. */
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
}

/**
 * Check an edit's before/after pair for the AADC / ADCC / ABDC shapes.
 *
 * @returns every anomaly found; an empty array means the edit's shape looks
 *          like a plain replacement.
 */
export function checkEditSanity(input: EditSanityInput): SanityFinding[] {
  const { before, after, oldText, newText } = input;
  if (before.length > MAX_SCAN_CHARS || after.length > MAX_SCAN_CHARS) return [];

  const findings: SanityFinding[] = [];

  // --- R1: this edit introduced two identical adjacent non-trivial lines ---
  const beforePairs = adjacentPairCounts(before);
  const afterPairs = adjacentPairCounts(after);
  for (const [key, afterCount] of afterPairs) {
    const beforeCount = beforePairs.get(key) ?? 0;
    if (afterCount <= beforeCount) continue;
    const shown = clip(key);
    findings.push({
      kind: 'adjacent-duplicate',
      line: shown,
      message:
        `The line "${shown}" now appears twice in a row. ` +
        `If new_text began or ended with a line that already bordered the replaced text, ` +
        `drop that line from new_text so the edit reads as a replacement.`
    });
  }

  // --- R2: new_text still contains old_text → nothing was replaced there ---
  // Deliberately NOT derived from the diff: a retained anchor is absorbed into
  // the common prefix/suffix, so only the raw argument comparison sees it.
  if (
    newText !== oldText &&
    newText.includes(oldText) &&
    oldText.replace(/\s+/g, '').length >= MIN_ANCHOR_CHARS &&
    after.length > before.length
  ) {
    findings.push({
      kind: 'anchor-retained',
      message:
        `new_text still contains old_text verbatim, so nothing was replaced at that spot — ` +
        `the text was only extended. That is correct for an intentional insertion; ` +
        `if you meant to REPLACE that line, keep only the replacement in new_text.`
    });
  }

  return findings;
}

/**
 * Render findings as the warning block appended to a successful edit result.
 *
 * @param findings - output of {@link checkEditSanity} (non-empty)
 * @param filePath - the path as the caller passed it, for the header
 * @returns a block starting with a newline, or '' when there is nothing to say
 */
export function formatSanityWarning(findings: SanityFinding[], filePath: string): string {
  if (findings.length === 0) return '';
  const bullets = findings.map((f) => `  - ${f.message}`).join('\n');
  return (
    `\n\n[Warning: possible unintended duplication in ${filePath} — the edit WAS applied, nothing was rolled back]\n` +
    `${bullets}\n` +
    `Review the edited region with read_file before moving on.`
  );
}
