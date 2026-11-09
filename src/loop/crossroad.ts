/**
 * crossroad.ts - Crossroad feature: detect turning words in LLM output,
 * generate alternative continuations, and select the best one.
 *
 * Flow:
 * 1. Ask the turning-point detector where the response turns (a p-value per
 *    streamed segment; mycc decides whether that is enough to trigger)
 * 2. Split the output into THREE segments at that point:
 *      prefix   — text before the turn (kept verbatim)
 *      cutpoint — the turning SEGMENT (the chunk the detector flagged)
 *      original — text after the segment (replaced by the continuation)
 * 3. Generate multiple continuations via forkChat in different directions
 * 4. Select the best continuation via LLM
 * 5. Reconstruct triologue with prefix + [turn] + C_best
 */

import type { Message, Tool } from '../types.js';
import type { RetryConfig } from '../engine/chat-helpers.js';
import { forkChat } from '../engine/chat-provider.js';
import { startSpinner, stopSpinner, sleep } from '../engine/chat-helpers.js';
import { agentIO } from './agent-io.js';
import { stripInternalMarkup } from '../utils/letter-box.js';
import { buildCrossroadCard, formatCrossroadCard } from './crossroad-card.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Turning-point detector (@pkubangbang/crossroad-detector)
// ============================================================================

/**
 * The ONLY source of turning-word detection.
 *
 * This module deliberately re-implements NO detection heuristic of its own.
 * The detector package owns the whole decision — its model is the classifier.
 * The `word` / `index` pair it returns is a lexical HINT extracted only after
 * the model has already answered `turn: true`; it selects which streamed
 * segment to cut at, it is never a detector and there is no regex-as-detector
 * path in mycc. Note `index` is a CODE POINT offset (the detector counts code
 * points) while JS strings are UTF-16, so it is converted at that boundary
 * before being used as a string position.
 *
 * Consequence (by design): when the detector cannot answer — package missing,
 * server failed to spawn, or it reports no turn — crossroad does NOT fire and
 * the LLM's turn passes through untouched. "No turn" and "no detector" are
 * both null on this API, so mycc cannot invent a verdict in either case.
 *
 * The detector spawns a detached HTTP server (hosting the INT8 ONNX DistilBERT)
 * on first use, managed via a lockfile at ~/.mycc-store/crossroad.lock.
 */
interface DetectorMatch {
  /** Anchor word reported by the detector (best-effort lexical hint). */
  word: string;
  /**
   * Offset of the anchor word in the ORIGINAL content, in CODE POINTS (the
   * detector's own unit — NOT UTF-16 units). Converted at the boundary by
   * `codePointIndexToUtf16` before being used as a string position.
   */
  index: number;
  /** Model confidence P(turn) for the winning window. */
  score: number;
}

interface Detector {
  detect: (content: string) => Promise<DetectorMatch | null>;
}

let detector: Detector | null = null;
let detectorInitFailed = false;

async function getDetector(): Promise<Detector | null> {
  if (detector) return detector;
  if (detectorInitFailed) return null;
  // Escape hatch for tests and for hosts that must never spawn the model
  // server. It disables crossroad entirely (there is no in-process fallback).
  if (process.env.MYCC_CROSSROAD_DISABLE_SEMANTIC) {
    detectorInitFailed = true;
    return null;
  }
  try {
    const mod = await import('@pkubangbang/crossroad-detector');
    const lockPath = join(homedir(), '.mycc-store', 'crossroad.lock');
    detector = new mod.CrossroadDetector(lockPath, { threshold: 0.5 });
    return detector;
  } catch {
    detectorInitFailed = true;
    return null;
  }
}

// ============================================================================
// The three segments
// ============================================================================

/**
 * Where a response turns, expressed as a lossless three-way split of it.
 *
 * INVARIANTS (asserted by the unit tests):
 *   1. `remainder` follows `cutpoint` directly and `original === prefix +
 *      cutpoint + remainder` — a segment start is always an offset in the text.
 *   2. `cutpoint` is non-empty.
 *   3. `cutStart` is a SEGMENT start whose boundary the user may see — never the
 *      producer's size cap, never mid-segment.
 */
export interface TurningPoint {
  /** Text before the turn — kept verbatim in the response. */
  prefix: string;
  /**
   * The turning SEGMENT — what gets replaced by the continuation. It is NOT
   * "the turning word": the word and its offset are only the detector's
   * post-hoc lexical hint, so the cut is made at the start of the segment the
   * model flagged, not around the word.
   */
  cutpoint: string;
  /** Text after the cutpoint — the direction that the continuation replaces. */
  remainder: string;
  /** Offset where `cutpoint` starts (= `prefix.length`). */
  cutStart: number;
  /** Offset where `cutpoint` ends (= `cutStart + cutpoint.length`). */
  cutEnd: number;
}

/**
 * A cut this close to the start would produce a prefix the model can neither
 * anchor on nor meaningfully keep; treat it as "no usable turn".
 * (Matches the detector's own "must have committed to a direction" spirit.)
 *
 * Stated in CHARACTERS OF TEXT, which is why adopting the package's cut grid
 * left it unchanged: a character count does not move when the units it is
 * counted over do.
 */
export const MIN_PREFIX_LENGTH = 30;

/** A cut this close to the end would leave nothing for the continuation to replace. */
export const MIN_REMAINDER_LENGTH = 15;

// ============================================================================
// Segmentation — the cut grid
// ============================================================================

/**
 * ONE segment of the cut grid: `[start, end)` in UTF-16 offsets into the
 * response, plus the kind of boundary that opened it.
 *
 * `cutKind` is a fact about the TEXT, not about who produced it — and mycc only
 * asks one thing of it: *may the user see a cut here?*
 *   - `'sentence'` — newline, or a terminator followed by whitespace/EOL.
 *   - `'clause'`   — clause punctuation (`,` `;` `:` and their CJK twins).
 *   - `'forced'`   — the producer's size cap was hit mid-clause. It may have
 *                    fallen inside a word, so this boundary is NEVER shown to
 *                    the user as a cutpoint.
 *
 * The package names these after the boundary that CLOSES a segment. mycc cuts at
 * the boundary that OPENS a segment, so the label is shifted by one here: a
 * segment's `cutKind` is what its left boundary may be used for.
 */
export interface CutSegment {
  start: number;
  end: number;
  cutKind: 'sentence' | 'clause' | 'forced';
}

/**
 * The detector package's segmenter, reached through its frozen public contract
 * (`createSegmenter` / `segmentsOf`). mycc declares only the surface it calls.
 *
 *   createSegmenter({ splitPolicy }) -> { push(delta) -> Segment[], flush(), pending }
 *   Segment = { start, end, cutKind }        // ABSOLUTE, CUMULATIVE code points
 *
 * Segments are FINAL once returned; `push` may return `[]` (a trailing `.` is
 * ambiguous until the next character or `flush`).
 */
export interface PkgSegment {
  start: number;
  end: number;
  cutKind: 'sentence' | 'clause' | 'forced';
}

export interface PkgSegmenter {
  push(delta: string): PkgSegment[];
  flush(): PkgSegment[];
  readonly pending: string;
}

export type PkgCreateSegmenter = (opts?: { splitPolicy?: 'trained' | 'sentence' }) => PkgSegmenter;

type PkgSegmentsOf = (text: string, opts?: { splitPolicy?: 'trained' | 'sentence' }) => PkgSegment[];

/**
 * Where the cut grid comes from: the package's `segmentsOf` — the implementation
 * the model was trained against, so the units being replaced ARE the units the
 * model scored. mycc's former local boundary rules are deleted; there is no
 * second producer and no second call site that could load a second copy of the
 * package.
 *
 * Wiring it is ONE call by the host in `initCrossroad` (see `setSegmentSource`).
 * Left unwired the grid is EMPTY, so `resolveTurningPoint` refuses every hint
 * and crossroad stays out of the way: a missing grid must never be papered over
 * with a different segmentation, which would cut on units nothing scored.
 */
let pkgSegments: PkgSegmentsOf | null = null;

/**
 * Wire the grid producer.
 *
 * The HOST calls this once, passing the value it imported at top level:
 *
 *     import { segmentsOf } from '@pkubangbang/crossroad-detector';
 *     initCrossroad(segmentsOf);
 *
 * It is not an implicit `await import()` inside this module for two reasons:
 * a dynamic import lands after the first response has started streaming, and in
 * a test runner it resolves to a SECOND module instance — the wired function
 * would then not be the one the test imported, and identity-based assertions
 * would silently compare two copies of the same code.
 */
export function initCrossroad(segments: PkgSegmentsOf): void {
  pkgSegments = segments;
}

/** Test hook: replace the grid producer (null = unwired). */
export function usePackageSegmenter(factory: PkgSegmentsOf | null): void {
  pkgSegments = factory;
}

/**
 * Every segment of `content`, as UTF-16 offsets.
 *
 * The package speaks CODE POINTS and `String.prototype.slice` counts UTF-16
 * units, so this is the ONE place the two units meet — the same boundary
 * discipline `codePointIndexToUtf16` applies to the detector's hint. They differ
 * only past an ASTRAL character (1 code point = 2 UTF-16 units).
 *
 * The segments are a PARTITION: `start` ascends, each `end` is the next `start`
 * (a blank line is therefore two one-character segments), the first starts at 0
 * and the last ends at `content.length`. Any segment start is thus a cut that
 * neither skips nor duplicates text.
 *
 * `cutKind` is shifted to the OPENING boundary (see `CutSegment`): the first
 * segment inherits the kind its own end closed with (it opens at the text
 * start, where there is no cut to take), and every later one carries the kind
 * its predecessor was closed by — which is exactly the boundary between them.
 *
 * The package keeps the whitespace that FOLLOWS a sentence terminator inside
 * the next segment (" Wait,"), so the shifted kind is the sentence one there:
 * see `resolveTurningPoint`, which trims that leading whitespace off the cut.
 *
 * CONSUMER NORMALISATION — four rules, none of them a trainer rule. The package
 * reports the character lattice the model's spans were built over; a CUT
 * consumer needs a different object (a replacement unit that a reader saw), and
 * these four rules are the whole of that difference:
 *
 * N1. COVERAGE. The lattice is not a partition: whitespace-only parts are
 *     dropped by the trainer and a whitespace-only tail is not emitted at all.
 *     A cut consumer cannot treat "no unit here" as "nothing to cut", so each
 *     gap is filled by extending the unit before it. This is the one structural
 *     guarantee callers may rely on: the units tile `0..content.length`.
 *
 * N2. SENTENCES, NOT CLAUSES. The model scores SPANS; a clause unit was never
 *     something it commented on. For "However, the real issue is in the API
 *     layer." cutting at the comma would replace 8 characters the reader never
 *     saw as a unit and start the continuation mid-sentence, so a clause-closed
 *     segment is JOINED into its sentence. This stays even when the package
 *     returns the trainer lattice — it is a choice about the replacement unit,
 *     not a workaround for a coarse grid.
 *
 * N3. NO CUT ON A NEWLINE. The 0.2.1 lattice has no blank-line units: a
 *     paragraph break CLOSES the unit before it, and N2/N4 already carry a
 *     `clause` part forward, so no unit opens on a newline. The rule that no cut
 *     may start on whitespace is kept here explicitly (the cut trims to the
 *     unit's first non-whitespace), because the package keeps the space after a
 *     sentence terminator inside the NEXT unit (" Wait,").
 *
 * N4. NO CUT INSIDE A NUMBER. `_SENT_SPLIT` is a plain look-behind, so
 *     "version 0.9.7" is split into `0.` | `9.` | `7`. That is the right lattice
 *     for spans, but a cut at `'9.'` would replace a fragment of a version
 *     number. A unit with EITHER edge inside a numeric token is carried forward
 *     exactly like a clause — both edges, because the opening-edge rule alone
 *     still cut `9.7 and the release is today.` in the test.
 */
export function segmentsOf(content: string): CutSegment[] {
  if (!pkgSegments || content.length === 0) return [];
  const produced = pkgSegments(content, { splitPolicy: 'trained' });
  if (produced.length === 0) return [];
  // OFFSETS ARE NOT REPAIRED. A producer offset that cannot be a position in
  // `content` (negative, non-integer, past the end, or a span that does not
  // ascend) is a contract violation, and papering it over with a plausible
  // substitute would build a cut at a position that never existed. Refuse the
  // whole grid instead: no grid means no cut, which is the honest outcome.
  const mapped: Array<{ start: number; end: number; closedBy: CutSegment['cutKind'] }> = [];
  for (const s of produced) {
    const start = codePointIndexToUtf16(content, s.start);
    const end = codePointIndexToUtf16(content, s.end);
    if (start === null || end === null || end <= start) return [];
    if (mapped.length > 0 && start < mapped[mapped.length - 1].end) return [];
    mapped.push({ start, end, closedBy: s.cutKind });
  }
  // N1 COVERAGE: extend each unit over the hole that follows it, so the units
  // tile the text. (A dropped whitespace-only part belongs to the text before it.)
  const raw = mapped.map((s, i) => ({
    start: i === 0 ? 0 : Math.max(mapped[i - 1].end, mapped[i].start),
    end: i + 1 < mapped.length ? Math.max(s.end, mapped[i + 1].start) : content.length,
    closedBy: s.closedBy
  }));
  // N2/N4 (clause or in-token number) carry a segment into the one after it until
  // a real boundary closes the unit. `forced` is joined by none: it may sit
  // inside a word, and absorbing it would make the whole run uncuttable — it stays
  // a boundary callers must refuse. No blank-line branch: the 0.2.1 lattice
  // closes a unit at a paragraph break and N1's fill absorbs a whitespace run.
  const units: typeof raw = [];
  let carry: (typeof raw)[number] | null = null;
  for (const seg of raw) {
    const next: (typeof raw)[number] = carry ? { ...seg, start: carry.start } : { ...seg };
    carry = null;
    const inside = edgeInsideNumber(content, next.start);
    const closesInside = edgeInsideNumber(content, next.end);
    if (next.closedBy === 'clause' || inside || closesInside) {
      carry = next;
      continue;
    }
    units.push(next);
  }
  if (carry) units.push(carry);
  return units.map((s, i) => ({
    start: s.start,
    end: s.end,
    cutKind: (i === 0 ? s.closedBy : units[i - 1].closedBy) as CutSegment['cutKind']
  }));
}

/**
 * Does the boundary at `at` fall INSIDE a numeric token — i.e. does the
 * separator `.`/`,`/`;`/`:` just before that boundary have a digit on BOTH
 * sides?
 *
 *   "0.9.7"  — the boundary after "0." has '.' with "0" behind and "9" in
 *   front → inside. Same for the boundary after "9.".
 *   "day 5." — the boundary after the period has '.' with "5" behind and " " in
 *   front → NOT inside, so a sentence ending in a digit+period stays a real
 *   sentence boundary and the next sentence is not glued to it.
 *
 * The caller asks the same question for both edges of a unit (its start and its
 * end), because either one landing inside a token is enough to make the unit a
 * bad thing to replace.
 */
function edgeInsideNumber(content: string, at: number): boolean {
  const sepIndex = at - 1;
  if (sepIndex < 1 || sepIndex >= content.length) return false;
  if (!/^[.,;:]$/.test(content[sepIndex])) return false;
  const before = content[sepIndex - 1];
  const after = content[sepIndex + 1];
  return /\d/.test(before) && after !== undefined && /\d/.test(after);
}

/**
 * The cut for a detector hint at `offset` (UTF-16), or null.
 *
 * The protocol's unit of decision is the SEGMENT: the detector is asked "does
 * the turn happen in this segment?", so the replacement must begin where that
 * segment begins. Cutting at the hint's own offset would split a unit the
 * detector scored as one and replace a position it never evaluated.
 *
 * Rules:
 *   - Hint inside a segment → that segment's start (never mid-segment).
 *   - Hint in a segment whose start may not be shown (the text start, or a
 *     boundary the producer closed at its size cap) → move FORWARD to the first
 *     showable boundary: "the turn is what gets said next", never backward onto
 *     text the detector never flagged.
 *   - Leading whitespace is trimmed off the CUTPOINT, so it never begins with a
 *     space or a newline ("…now. Wait," cuts at "Wait,", not at " Wait,") and the
 *     cut keeps the whole three-way partition: `prefix + cutpoint + remainder
 *     === content`. The trim is applied to the chosen boundary itself, NOT
 *     relative to the hint: a detector hint that lands exactly on the boundary
 *     is the common case, and gating the trim on `start < offset` let the space
 *     through on precisely that case.
 */
function cutStartFor(segs: CutSegment[], offset: number, content: string): number | null {
  const idx = segAt(segs, offset);
  if (idx < 0) return null;
  // A hint ON a boundary belongs to the segment that STARTS there (containment).
  const candidate = canCutAt(segs[idx], content) ? segs[idx].start : nextCutAfter(segs, idx, content);
  if (candidate === null) return null;
  let start = candidate;
  while (start < content.length && /\s/.test(content[start])) start++;
  return start;
}

/** First showable cut boundary strictly after segment `idx`, or null. */
function nextCutAfter(segs: CutSegment[], idx: number, content: string): number | null {
  for (let i = idx + 1; i < segs.length; i++) {
    if (canCutAt(segs[i], content)) return segs[i].start;
  }
  return null;
}

/**
 * May a cut be shown at this segment's start? It needs a prefix before it, a
 * boundary the user may see, and text to carry: a whitespace-only run is never a
 * place to start the replacement.
 *
 * `content` is a PARAMETER, not module state: the answer is a fact about one
 * text, and a module-global copy let a grid computed for text A be judged
 * against text B.
 */
function canCutAt(seg: CutSegment, content: string): boolean {
  return seg.start > 0 && seg.cutKind !== 'forced' && /[^\s]/.test(content.slice(seg.start, seg.end));
}

/** Index of the segment containing `offset` (they partition the text). */
function segAt(segs: CutSegment[], offset: number): number {
  if (segs.length === 0 || offset < 0 || offset >= segs[segs.length - 1].end) return -1;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < segs[mid].start) hi = mid - 1;
    else if (offset >= segs[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Start of the SEGMENT containing `position` — "which unit's text does this
 * offset lie in". Clamped into range.
 */
export function segmentStartAt(content: string, position: number): number {
  const segs = segmentsOf(content);
  const pos = Math.max(0, Math.min(position, content.length - 1));
  const idx = segAt(segs, pos);
  if (idx < 0) return 0;
  // The cut at this segment — the same rule the resolver uses, so "the segment
  // this offset lies in" and "where the cut would land" never disagree.
  return cutStartFor(segs, pos, content) ?? segs[idx].start;
}

/**
 * End of the segment starting at `start` — the next segment's start, or the end
 * of the text for the last one. `null` when `start` is not a segment start.
 */
export function segmentEndAfter(content: string, start: number): number | null {
  const segs = segmentsOf(content);
  const idx = segs.findIndex((s) => s.start === start);
  return idx >= 0 ? segs[idx].end : null;
}

/**
 * Start of the segment at `position`, or — when `position` falls at a boundary
 * that may not be shown — the next showable boundary. `null` when none follows.
 * Used for "the turn is what gets said next".
 */
export function segmentStartAfter(content: string, position: number): number | null {
  const segs = segmentsOf(content);
  for (const seg of segs) {
    if (seg.start >= position && canCutAt(seg, content)) return seg.start;
  }
  return null;
}

/**
 * Convert a CODE-POINT offset (the detector's unit) into a UTF-16 offset (the
 * unit `String.prototype.slice` uses). Returns null when the offset lands
 * beyond the end of the text — a stale or foreign index, not a position we can
 * honour.
 *
 * The two units differ only by the number of ASTRAL characters (U+10000 and
 * above — emoji, CJK extension B) before the offset: each occupies 1 code point
 * but 2 UTF-16 units. Pure-BMP text (all ordinary Latin and Chinese) needs no
 * adjustment, which is why this was invisible until an emoji appeared.
 */
function codePointIndexToUtf16(content: string, codePointIndex: number): number | null {
  if (!Number.isInteger(codePointIndex) || codePointIndex < 0) return null;
  // Fast path: no astral character can be present, so the units coincide.
  if (codePointIndex <= content.length && !/[\uD800-\uDFFF]/.test(content)) return codePointIndex;
  const points = Array.from(content);
  if (codePointIndex > points.length) return null;
  return points.slice(0, codePointIndex).join('').length;
}

// ---------------------------------------------------------------------------

export function resolveTurningPoint(content: string, match: DetectorMatch): TurningPoint | null {
  const anchor = (match.word ?? '').trim();
  const index = match.index;

  if (!Number.isFinite(index) || index < 0) return null;
  // UNITS: the detector reports `index` as a CODE-POINT offset (its server
  // windows text over code points — see crossroad-detector's server.ts —
  // precisely so astral characters cannot misalign a window). mycc slices with
  // String.prototype.slice, which counts UTF-16 units, so the two agree only
  // while the text is pure BMP. Convert once, here, and everything downstream
  // stays in UTF-16 offsets.
  const position = codePointIndexToUtf16(content, index);
  if (position === null || position >= content.length) return null;
  // The hint's offset is a supplement to a model answer rather than always a
  // verbatim anchor; trust the anchor when it resolves at or after the offset,
  // else use the reported offset itself as the point inside a segment.
  const anchorAt = anchor ? content.indexOf(anchor, position) : -1;
  const hint = anchorAt >= 0 ? anchorAt : position;

  const segs = segmentsOf(content);
  const cutStart = cutStartFor(segs, hint, content);
  if (cutStart === null) return null;
  const seg = segs[segAt(segs, cutStart)];
  if (!seg) return null;
  // I7: the FINAL segment runs to the end of the response, so there is no
  // remainder after it. Replacing the segment's first sentence makes the rest
  // of that sentence-set the remainder in the common case; when the turn IS the
  // last sentence there is nothing to keep, and the cut is still valid — the
  // guard below only rejects a cut that leaves a HALF-PHRASE behind.
  const isFinalSegment = seg.end >= content.length;
  // I7: the FINAL unit runs to the end of the response, so it is replaced WHOLE —
  // there is no remainder, and the mid-text remainder guard (below) cannot apply.
  // Extending it to a guessed sentence end would leave a fragment neither kept nor
  // replaced, so the final unit is taken as the grid gives it.
  //
  // `forced` IS REFUSED AT BOTH EDGES. A `'forced'` boundary is the producer's
  // size cap and can land mid-word; `canCutAt` refuses it as a START, and taking
  // it as the END would splice the continuation into the middle of a word. A unit
  // that ends there is therefore not a replacement unit at all.
  if (seg.cutKind === 'forced') return null;
  const cutEnd = seg.end;
  // N3: the 0.2.1 lattice has no blank-line units and N1's fill absorbs trailing
  // whitespace, so a unit can END on the paragraph mark before the next one (or on
  // the trailing run at the end of the text). A cut may not KEEP that whitespace:
  // the cutpoint is the unit trimmed, and the trimmed tail stays in the remainder
  // so `prefix + cutpoint + remainder === content` still holds.
  const unit = content.slice(cutStart, cutEnd);
  const trimmedEnd = cutStart + unit.replace(/\s+$/, '').length;
  const cut = trimmedEnd > cutStart ? trimmedEnd : cutEnd;

  // GUARDS ARE COUNTED IN CHARACTERS, not UTF-16 units. The offsets are UTF-16
  // (that is what `slice` takes) but the constants are statements about how much
  // TEXT the reader gets, so the comparison is made on code points: a prefix of
  // 16 emoji is 16 characters, not 32, and must not pass a 30-character guard.
  if (charLength(content.slice(0, cutStart)) < MIN_PREFIX_LENGTH) return null;
  // MID-TEXT ONLY: a cut that leaves a sliver after it is refused — the
  // continuation would replace almost everything and keep a stub. The final unit
  // has no after-it, so a short tail is the cut's own last words, not a sliver.
  if (charLength(content.slice(cut)) < MIN_REMAINDER_LENGTH && !isFinalSegment) return null;

  return {
    prefix: content.slice(0, cutStart),
    cutpoint: content.slice(cutStart, cut),
    remainder: content.slice(cut),
    cutStart,
    cutEnd: cut
  };
}

/**
 * Length of `text` in CHARACTERS (code points), which is the unit the two guards
 * are stated in. `text.length` counts UTF-16 units and would double every astral
 * character (emoji, rare CJK), halving the effective threshold.
 */
function charLength(text: string): number {
  // Fast path: no surrogate can be present, so the counts coincide.
  if (!/[\uD800-\uDFFF]/.test(text)) return text.length;
  return Array.from(text).length;
}

/**
 * Detect the turning point of a response.
 *
 * Returns null when the detector is unavailable OR reports no turn — in both
 * cases crossroad stays out of the way. Observability deliberately
 * distinguishes the two so a silently missing model server is not mistaken for
 * a response that simply never turned.
 */
export async function detectTurningPoint(content: string): Promise<TurningPoint | null> {
  const det = await getDetector();
  if (!det) {
    agentIO.verbose('crossroad', 'detector unavailable — crossroad skipped');
    return null;
  }
  if (pkgSegments === null) {
    agentIO.verbose('crossroad', 'segmenter not wired — crossroad skipped');
    return null;
  }
  let match: DetectorMatch | null;
  try {
    match = await det.detect(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentIO.verbose('crossroad', `detector failed (${msg}) — crossroad skipped`);
    return null;
  }
  if (!match) return null;

  const point = resolveTurningPoint(content, match);
  if (!point) {
    agentIO.verbose(
      'crossroad',
      `detector reported "${match.word}" at ${match.index} but the cut is not usable — crossroad skipped`
    );
    return null;
  }
  agentIO.verbose(
    'crossroad',
    `Detected turning point "${point.cutpoint.trim()}" at ${point.cutStart}[${point.cutEnd}] (score ${match.score})`
  );
  return point;
}

// ============================================================================
// Direction Prompts for Continuation Generation
// ============================================================================

interface GenerationDirection {
  name: string;
  /** Build the direction prompt, injecting the anchor sentence to repeat. */
  buildPrompt: (wordsBeforeTurn: string) => string;
}

/**
 * Core instruction appended to every direction. The anchor sentence
 * (wordsBeforeTurn) is the last sentence of the prefix — the LLM MUST
 * start by repeating it verbatim, so the continuation dovetails with
 * the prefix and no earlier prefix content is restated. The post-
 * processing in stripAndValidate then removes the anchor, leaving only
 * the genuinely new content.
 */
const ANCHOR_INSTRUCTION = (wordsBeforeTurn: string): string =>
  `\n\nYou MUST start your continuation by repeating this exact sentence from the prefix verbatim:\n"""\n${wordsBeforeTurn}\n"""\nAfter that sentence, provide your new direction. Do not restate any other content from the prefix — the user has already seen it. Keep your continuation brief — at most 2-3 concise sentences after the anchor. Do not start a new complex reasoning chain; just provide a short, clear direction pivot.`;

const GENERATION_DIRECTIONS: GenerationDirection[] = [
  {
    name: 'go forward',
    buildPrompt: (w) =>
      `You are generating a continuation for a response that was cut off. Continue in a proactive, action-oriented direction. Focus on what to do next, taking decisive steps. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.${ANCHOR_INSTRUCTION(w)}`
  },
  {
    name: 'go backward',
    buildPrompt: (w) =>
      `You are generating a continuation for a response that was cut off. Reconsider the basic assumptions and be cautious. Question whether the current direction is correct, and suggest re-examining foundations before proceeding. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.${ANCHOR_INSTRUCTION(w)}`
  },
  {
    name: 'synthesize at a high level',
    buildPrompt: (w) =>
      `You are generating a continuation for a response that was cut off. Step back and provide a higher-level abstraction. Synthesize the situation, identify the core question or principle at play, and reframe the problem in broader terms. Output ONLY the continuation text — no preamble, no sign-off, no tool calls. Start directly from where the prefix left off, maintaining the same tone and voice.${ANCHOR_INSTRUCTION(w)}`
  }
];

/**
 * Tighter retry config for crossroad continuation generation.
 * Crossroad continuations are short text-only responses, so the generous
 * defaults (20s first-token / 120s response) would cause unacceptable
 * delays during network failures. 10s/30s with 1 retry is sufficient.
 */
const CROSSROAD_RETRY_CONFIG: Partial<RetryConfig> = {
  firstTokenTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  maxRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 3_000
};

// ============================================================================
// Continuation Generation
// ============================================================================

/**
 * Validate that a continuation starts with the anchor sentence (wordsBeforeTurn)
 * and strip the anchor, leaving only the new content.
 *
 * The generation prompt forces the LLM to begin by repeating wordsBeforeTurn
 * verbatim. This function checks that requirement:
 *  - If the continuation starts with wordsBeforeTurn → strip it, return the rest.
 *  - If the continuation does NOT start with wordsBeforeTurn → return null
 *    (validation failed — caller should retry, then give up).
 *  - If wordsBeforeTurn is empty → return the continuation unchanged (no anchor
 *    to enforce; e.g. prefix was empty or had no sentence boundary).
 *  - If stripping leaves nothing → return null (continuation was ONLY the anchor).
 *
 * @param wordsBeforeTurn - The anchor sentence (last sentence of the prefix)
 * @param continuation - The raw continuation text (already stripInternalMarkup'd)
 * @returns The continuation with the anchor removed, or null if validation failed
 */
export function stripAndValidate(wordsBeforeTurn: string, continuation: string, prefix?: string): string | null {
  let candidate = continuation.trim();

  // A retry can ignore the instruction not to repeat already-shown text and
  // echo the whole prefix. Since the prefix already contains the anchor sentence,
  // removing the whole prefix also completes validation for this recovery path.
  //
  // THIS BRANCH RUNS FIRST, BEFORE ANY ANCHOR CHECK. With no anchor sentence
  // (empty prefix, or a prefix the grid found no unit in) the old order returned
  // the candidate untouched — so a continuation that merely RESTATED the prefix
  // was appended to the prefix, and the reader saw the same prose twice. A
  // restatement is stripped here regardless of whether an anchor exists.
  if (prefix && candidate.startsWith(prefix)) {
    candidate = candidate.slice(prefix.length).trim();
    // The model may additionally re-echo the anchor after the prefix
    // ("prefix + anchor + new"). Strip it too so the anchor does not survive
    // as duplicated content.
    if (wordsBeforeTurn && candidate.startsWith(wordsBeforeTurn)) {
      candidate = candidate.slice(wordsBeforeTurn.length).trim();
    }
    return candidate.length > 0 ? candidate : null;
  }

  if (!wordsBeforeTurn) {
    // No anchor to enforce — but a candidate the PREFIX does not start with is
    // still required to bring something new: an exact restatement of the last
    // sentence of the prefix is duplication just the same.
    if (prefix) {
      const lastLine = prefix.trimEnd();
      if (lastLine.length > 0 && candidate.startsWith(lastLine)) {
        const rest = candidate.slice(lastLine.length).trim();
        return rest.length > 0 ? rest : null;
      }
    }
    return candidate;
  }
  if (candidate.startsWith(wordsBeforeTurn)) {
    let stripped = candidate.slice(wordsBeforeTurn.length).trim();
    // Also handle an anchor followed by a second copy of the full prefix.
    if (prefix && stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length).trim();
    }
    return stripped.length > 0 ? stripped : null;
  }
  return null;
}

/**
 * Extract the last sentence of the prefix — the anchor that continuations must
 * repeat verbatim before pivoting.
 *
 * THE SENTENCE BOUNDARIES COME FROM THE SAME GRID AS THE CUT. A second, private
 * sentence splitter here was a second producer of "where a sentence ends", and it
 * disagreed with the one the cut was made on: it only treated `。！？` as a
 * terminator when nothing followed, so Chinese text — which has no space after
 * `。` — came back as ONE sentence and the anchor became the entire prefix. Every
 * direction was then asked to repeat the whole prefix verbatim; none could, and
 * crossroad abandoned nearly every Chinese reply. Asking `segmentsOf` instead is
 * also what the layering rule demands: a fact about sentence boundaries belongs
 * to the layer whose evidence produced it — the package lattice.
 *
 * Falls back to the whole trimmed prefix when the grid is unavailable (unwired
 * segmenter, or a text that yields no units), which is the same anchor the old
 * splitter produced for a single-sentence prefix.
 */
export function extractWordsBeforeTurn(prefix: string): string {
  const segs = segmentsOf(prefix);
  if (segs.length === 0) return prefix.trim();
  // Walk back from the end: the anchor is the last unit that carries text. A
  // trailing whitespace run (a paragraph mark) is not an anchor, and
  // `stripAndValidate` compares against the TRIMMED anchor, so a unit ending in
  // `\n\n` must be trimmed to match what the model is asked to repeat.
  for (let i = segs.length - 1; i >= 0; i--) {
    const text = prefix.slice(segs[i].start, segs[i].end).trim();
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * Generate continuations from multiple directions using forkChat.
 * Runs all directions in parallel via Promise.allSettled.
 * Passes full tools + toolChoice: 'none' to preserve prompt cache
 * while constraining text-only output.
 *
 * Each continuation MUST start with the anchor sentence (wordsBeforeTurn).
 * stripAndValidate checks this and strips the anchor. If validation fails,
 * that direction is retried once with the same prompt. If the retry also
 * fails validation, the direction is skipped (not included in results).
 *
 * Returns array of continuation strings (anchor stripped), or empty array
 * if all directions failed (including retries).
 */
export async function generateContinuations(
  messages: Message[],
  tools: Tool[],
  prefix: string,
  signal?: AbortSignal,
  wordsBeforeTurn: string = ''
): Promise<string[]> {
  // Inject the prefix into each direction prompt so the LLM sees what was
  // already said and continues from it rather than regenerating it from
  // scratch. Without this, forkChat only sees conversation history + the
  // direction instruction, so it restates the prefix before pivoting —
  // producing duplicated content in the final assembled output.
  const prefixBlock = `A response was cut off at a turning word. The prefix (before the turning word, already written and shown to the user) is:\n\n"""\n${prefix}\n"""\n\n`;

  /**
   * Run one direction: forkChat → stripInternalMarkup → stripAndValidate.
   * On validation failure, retry once. Returns the validated continuation
   * (anchor stripped) or null if both attempts fail.
   */
  const runDirection = async (direction: GenerationDirection): Promise<{ name: string; text: string } | null> => {
    const fullPrompt = prefixBlock + direction.buildPrompt(wordsBeforeTurn);

    // First attempt
    let raw = await forkChat(messages, tools, fullPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG);
    let cleanText = stripInternalMarkup((raw || '').trim());
    let validated = stripAndValidate(wordsBeforeTurn, cleanText, prefix);
    if (validated !== null) {
      return { name: direction.name, text: validated };
    }

    // Retry once — validation failed (continuation didn't start with anchor)
    agentIO.verbose('crossroad', `Direction "${direction.name}" failed anchor validation, retrying...`);
    await sleep(300);
    raw = await forkChat(messages, tools, fullPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG);
    cleanText = stripInternalMarkup((raw || '').trim());
    validated = stripAndValidate(wordsBeforeTurn, cleanText, prefix);
    if (validated !== null) {
      return { name: direction.name, text: validated };
    }

    // Both attempts failed — skip this direction
    agentIO.verbose('crossroad', `Direction "${direction.name}" failed anchor validation after retry, skipping.`);
    return null;
  };

  const results = await Promise.allSettled(GENERATION_DIRECTIONS.map((direction) => runDirection(direction)));

  const continuations: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      agentIO.verbose('crossroad', `Direction "${result.value.name}" produced: ${result.value.text.slice(0, 100)}...`);
      continuations.push(result.value.text);
    } else if (result.status === 'rejected') {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      agentIO.verbose('crossroad', `Direction failed: ${msg}`);
    }
    // else: fulfilled with null → already logged in runDirection
  }

  return continuations;
}

// ============================================================================
// Continuation Selection
// ============================================================================

/**
 * Build the selection prompt that presents all continuations to the LLM.
 */
function buildSelectionPrompt(prefix: string, continuations: string[]): string {
  const parts: string[] = [
    `A response was cut off at a turning word. The prefix (before the turning word) is:\n\n"""\n${prefix}\n"""\n\n`,
    `Below are ${continuations.length} possible continuations for this response. Read each one carefully, then select the BEST one.\n\n`
  ];

  for (let i = 0; i < continuations.length; i++) {
    parts.push(`---\nOption ${i + 1}:\n${continuations[i]}\n`);
  }

  parts.push(`\n---\n`);
  parts.push(`Which option is the best continuation? Consider:
1. Which one flows most naturally from the prefix?
2. Which one is most useful and actionable?
3. Which one shows the best judgment?
4. Which one is most concise and direct?

Reply with EXACTLY ONE line containing only the option number (e.g., "1", "2", or "3").
Then on the next line, optionally provide the full text of that option as the continuation.
No other text, no preamble, no sign-off.`);

  return parts.join('');
}

/**
 * Pick the best continuation. Returns the chosen TEXT and its INDEX in
 * `continuations`, so the caller never has to look the text up again.
 *
 * The index is returned rather than re-derived because looking it up was how the
 * card lost its winner: when the selector answered with a lightly reworded
 * version of option 2, `continuations.indexOf(text)` found nothing, the index
 * became -1, and the UI showed a card with no row marked selected while the
 * merged outcome was that free text. Reporting both together makes that state
 * unrepresentable.
 */
export async function selectBestContinuation(
  messages: Message[],
  tools: Tool[],
  prefix: string,
  continuations: string[],
  signal?: AbortSignal
): Promise<{ text: string; index: number }> {
  if (continuations.length === 0) {
    return { text: '', index: -1 };
  }
  if (continuations.length === 1) {
    return { text: continuations[0], index: 0 };
  }

  const selectionPrompt = buildSelectionPrompt(prefix, continuations);

  try {
    const response = await forkChat(messages, tools, selectionPrompt, signal, 'none', CROSSROAD_RETRY_CONFIG);
    const text = (response || '').trim();
    agentIO.verbose('crossroad', `Selection response: ${text.slice(0, 200)}...`);

    // Try to parse the selected option number from the response
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const firstLine = lines[0] || '';

    // Match "N" or "Option N" at the start
    const optionMatch = firstLine.match(/^(?:option\s*)?(\d+)/i);
    if (optionMatch) {
      const optionIndex = parseInt(optionMatch[1], 10) - 1;
      if (optionIndex >= 0 && optionIndex < continuations.length) {
        // The named option WINS. Free text below the number is only taken when
        // it is that option's own text (the prompt invites the selector to
        // repeat it); anything else is a paraphrase, and a paraphrase is not a
        // draft — merging it would ship text no direction produced and no
        // validation ever checked.
        if (lines.length > 1) {
          const repeated = lines.slice(1).join('\n');
          if (repeated.trim() === continuations[optionIndex].trim()) {
            return { text: continuations[optionIndex], index: optionIndex };
          }
        }
        return { text: continuations[optionIndex], index: optionIndex };
      }
    }

    // If selection parsing failed, just return the best matching continuation
    // by checking which one appears in the response
    for (let i = 0; i < continuations.length; i++) {
      if (text.includes(continuations[i].slice(0, 50))) {
        return { text: continuations[i], index: i };
      }
    }

    // Fallback: return the first continuation
    agentIO.verbose('crossroad', 'Could not parse selection, using first continuation');
    return { text: continuations[0], index: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentIO.verbose('crossroad', `Selection failed: ${msg}`);
    return { text: continuations[0], index: 0 };
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

export interface CrossroadResult {
  /** Text before the turning word (kept verbatim). */
  truncated: string;
  /** The turning word + its following separator — the material replaced. */
  cutpoint: string;
  /** Original text after the cutpoint (the direction that was replaced). */
  original: string;
  /** Offset where the cutpoint starts within the original content. */
  cutStart: number;
  /** Offset where the cutpoint ends within the original content. */
  cutEnd: number;
  /** The best continuation text */
  continuation: string;
  /** All candidate continuations (for the crossroad record file) */
  candidates: string[];
  /** Index of the selected continuation within `candidates` (-1 if unknown) */
  selectedIndex: number;
}

/**
 * Build the "best-of-three" candidate brief block as markdown, for display
 * BETWEEN the prefix and the resolved outcome.
 *
 * Kept here (not in hook.ts) so the direction names stay co-located with
 * GENERATION_DIRECTIONS — the label for candidate i is the i-th direction's
 * name, and that pairing is an invariant of this module. hook.ts calls this
 * after showing the prefix and before showing the outcome, preserving the
 * intended 3-part reading order: prefix → candidates → outcome.
 *
 * Renders cleanly in BOTH the terminal (plain text is readable) and the Web
 * UI (markdown rendered for labeled `log` messages — see MessageItem.vue).
 * Avoids chalk/box-drawing characters: they leak ANSI codes into the Web UI
 * and a box breaks on narrow viewports.
 */
export function buildCandidatesBrief(candidates: string[], selectedIndex: number): string {
  const card = buildCrossroadCard({
    candidates,
    selectedIndex,
    directionNames: GENERATION_DIRECTIONS.map((d) => d.name)
  });
  // The card title/rows are the same information this function always produced;
  // the card module owns the preview normalization (flatten → de-markdown →
  // truncate) so a multi-line continuation can no longer break a row.
  return `\n${formatCrossroadCard(card)}`;
}

/**
 * Handle the crossroad feature:
 * 1. Ask the detector for the turning point
 * 2. Split the content into prefix / cutpoint / remainder at that point
 * 3. Generate multiple continuations from the prefix
 * 4. Select the best one
 *
 * Returns null if the detector is unavailable, finds no turn, or if all
 * generation fails. Shows spinner during processing.
 */
export async function handleCrossroad(
  messages: Message[],
  originalContent: string,
  tools: Tool[],
  signal?: AbortSignal
): Promise<CrossroadResult | null> {
  // Step 1 + 2: the detector decides where the response turns; the split is
  // derived from its match. No local heuristics are consulted.
  const point = await detectTurningPoint(originalContent);
  if (!point) {
    return null;
  }

  const { prefix } = point;
  // Extract the last sentence of the prefix — the anchor that continuations
  // must repeat verbatim. This enforces a clean dovetail: the continuation
  // starts by echoing the prefix's final sentence, then pivots. After
  // stripAndValidate removes the anchor, only genuinely new content remains.
  const wordsBeforeTurn = extractWordsBeforeTurn(prefix);

  // Show spinner during processing
  startSpinner('LLM is at its crossroad...');
  let result: CrossroadResult | null = null;
  let continuations: string[] = [];
  let selectedIndex = -1;
  try {
    // Step 3: Generate continuations (with crossroad-level retry)
    continuations = await generateContinuations(messages, tools, prefix, signal, wordsBeforeTurn);
    if (continuations.length === 0) {
      agentIO.verbose('crossroad', 'All continuations failed, retrying once...');
      await sleep(500);
      continuations = await generateContinuations(messages, tools, prefix, signal, wordsBeforeTurn);
    }
    if (continuations.length === 0) {
      agentIO.verbose('crossroad', 'No continuations generated after retry, aborting crossroad');
      return null;
    }

    // Step 4: Select the best one — text ALREADY PAIRED with its index, so the
    // card can never disagree with the merged outcome (see the selector's
    // docstring: a paraphrased answer used to yield index -1 and an unmarked card).
    const best = await selectBestContinuation(messages, tools, prefix, continuations, signal);
    if (!best.text) {
      agentIO.verbose('crossroad', 'Best continuation is empty, aborting crossroad');
      return null;
    }

    selectedIndex = best.index;
    agentIO.verbose('crossroad', `Selected continuation #${selectedIndex + 1}: ${best.text.slice(0, 150)}...`);
    result = {
      truncated: prefix,
      cutpoint: point.cutpoint,
      original: point.remainder,
      cutStart: point.cutStart,
      cutEnd: point.cutEnd,
      continuation: best.text,
      candidates: continuations,
      selectedIndex
    };
    return result;
  } finally {
    stopSpinner();
    // NOTE: the "best-of-three" candidate brief is NOT emitted here anymore.
    // Emitting it in this finally (during the LLM stage) put it BEFORE the
    // prefix, which is displayed later in the HOOK stage — the summary banner
    // appeared above the very content it summarized. The brief is now built by
    // buildCandidatesBrief() and emitted by hook.ts in the correct 3-part
    // order: prefix → candidates → outcome. The spinner stop stays here.
    if (result) {
      agentIO.verbose('crossroad', `Crossroad resolved: selected ${selectedIndex + 1} of ${continuations.length}`);
    }
  }
}







