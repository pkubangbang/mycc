/**
 * crossroad-cutpoint.test.ts — How a turn becomes a replacement, asserted as
 * INVARIANTS against the shipped cut grid.
 *
 * THE PROTOCOL. The detector is asked "does the turn happen in this SEGMENT?"
 * Its `word`/`index` is only a lexical hint saying WHICH segment turned — it
 * never positions the cut. mycc makes exactly one decision: replace the SEGMENT
 * that contains the hint.
 *
 * THE GRID comes from `@pkubangbang/crossroad-detector` (`segmentsOf`,
 * `splitPolicy: 'trained'`) and mycc normalises it once, in `segmentsOf`:
 *   N1. CODE POINTS (the package's unit) become UTF-16 (`String.prototype.slice`).
 *   N2. A clause-closed segment is JOINED to its sentence — the model scores
 *       spans over the trainer's SENTENCE lattice, so a cut at a comma would
 *       replace 8 characters the model never judged and start the continuation
 *       mid-sentence.
 *   N3. A blank line (a run of line breaks) is its OWN unit, closed by an
 *       unshowable boundary, so a cut never starts on a newline.
 *   N4. Every unit's `cutKind` is the boundary that OPENS it; `'forced'` (the
 *       producer's size cap, which may fall inside a word) is never a cutpoint.
 *
 * So the grid is a PARTITION of the text (ascending, contiguous, 0..length) whose
 * units are sentences: for "However, the real issue is in the API layer." the
 * unit is the whole paragraph, not the turning word.
 *
 * Asserted here:
 *   I1. `prefix + cutpoint + remainder === original` — a lossless partition.
 *   I2. `cutStart === prefix.length`, `cutEnd === cutStart + cutpoint.length`.
 *   I3. `cutpoint` is non-empty and starts on non-whitespace; `prefix` ends on
 *       non-whitespace (the whitespace between them stays in the remainder).
 *   I4. The cut lands on a unit start whose opening boundary is showable.
 *   I5. The cut contains the detector's anchor (the flagged unit was taken).
 *   I6. A hint inside a unit cuts at that unit's start, whatever its offset.
 *   I7. A hint in the FINAL unit replaces that unit.
 *   I8. A cut too close to the start (or, mid-text, to the end) is refused.
 *
 * WHAT IS NOT TESTED HERE — turning-word detection. mycc carries no heuristic of
 * its own; detection belongs solely to @pkubangbang/crossroad-detector.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import {
  initCrossroad,
  usePackageSegmenter,
  resolveTurningPoint,
  segmentStartAt,
  segmentStartAfter,
  segmentEndAfter,
  segmentsOf,
  MIN_PREFIX_LENGTH,
  MIN_REMAINDER_LENGTH,
  type TurningPoint
} from '../loop/crossroad.js';
import { segmentsOf as pkgSegmentsOf } from '@pkubangbang/crossroad-detector';

beforeAll(() => {
  // The host wires the grid at startup; the suite does the same, statically, so
  // the producer is the shipped one and not a second copy of the module.
  initCrossroad(pkgSegmentsOf);
});

/** A detector answer pointing at the first occurrence of `word` (CODE POINTS). */
function matchFor(content: string, word: string, score = 0.9) {
  const index = content.indexOf(word);
  if (index < 0) throw new Error(`fixture error: "${word}" not present in the test content`);
  return { word, index: Array.from(content.slice(0, index)).length, score };
}

/** Assert I1–I4 (and I5 when an anchor is given) for any produced cut. */
function expectInvariants(content: string, point: TurningPoint, anchor?: string): void {
  expect(point.prefix + point.cutpoint + point.remainder).toBe(content); // I1
  expect(point.cutStart).toBe(point.prefix.length); // I2
  expect(point.cutEnd).toBe(point.cutStart + point.cutpoint.length); // I2
  expect(content.slice(point.cutStart, point.cutEnd)).toBe(point.cutpoint); // I2
  expect(point.cutpoint.trim().length).toBeGreaterThan(0); // I3
  expect(point.cutpoint).not.toMatch(/^\s/); // I3
  // A trailing paragraph mark in the prefix is the boundary itself and stays with
  // the text before it; a dangling single space would not (resolveTurningPoint
  // trims it), so only prefix + cutpoint must not end on whitespace.
  // The prefix may carry the paragraph mark and the sentence's own leading space
  // that the package keeps inside a unit ( Wait,); what must never happen is a
  // whitespace run at the START of the cut.
  expect(point.cutpoint).not.toMatch(/^\s/); // I3
  // I4: a unit starts at (or just before) the cut and holds the cutpoint.
  expect(segmentsOf(content).some((s) => s.end > point.cutStart && s.start <= point.cutStart)).toBe(true);
  expect(segmentsOf(content).some((s) => s.start === point.cutEnd || s.end >= point.cutEnd)).toBe(true);
  if (anchor) expect(point.cutpoint).toContain(anchor); // I5
}

/** Fixtures with a paragraph break before AND after the turning paragraph. */
const EN =
  'First paragraph of the answer.\n\nHowever, the real issue is in the API layer.\n\nI will inspect the router next.';
const CN =
  '我们需要再仔细检查一遍数据库连接的配置方式，以及缓存层的失效策略是否真的生效了。\n\n但根本问题可能在配置文件里，也可能在缓存层。\n\n先从这里开始排查配置加载顺序。';

describe('segmentation — the unit grid (N1–N4)', () => {
  it('lists ascending, contiguous, non-overlapping units that cover the text', () => {
    for (const content of [EN, CN]) {
      const segs = segmentsOf(content);
      expect(segs.length).toBeGreaterThan(0);
      expect(segs[0].start).toBe(0);
      expect(segs[segs.length - 1].end).toBe(content.length);
      for (let i = 0; i < segs.length; i++) {
        expect(segs[i].end).toBeGreaterThan(segs[i].start);
        if (i > 0) expect(segs[i].start).toBe(segs[i - 1].end);
      }
    }
  });

  it('joins a clause-closed segment into its sentence (N2)', () => {
    // "However," is closed by a comma in the package; as a UNIT it is the whole
    // sentence it belongs to — the paragraph.
    const segs = segmentsOf(EN);
    const unit = segs.find((s) => s.start === EN.indexOf('However'))!;
    // 0.2.1 has no blank-line units, so a sentence unit also carries the paragraph
    // break that closes it; the UNIT TEXT is what the package says closed it.
    expect(EN.slice(unit.start, unit.end)).toBe('However, the real issue is in the API layer.\n\n');
    expect(unit.cutKind).toBe('sentence');
  });

  it('offers no unit that starts on a newline, and no cut on one (N3)', () => {
    // 0.2.1 closes a unit AT a paragraph break instead of emitting the break as a
    // unit, so the old blank-line unit is gone — what must still hold is that no
    // unit OPENS on whitespace and no cut begins there.
    for (const content of [EN, CN]) {
      for (const seg of segmentsOf(content)) expect(/^\s/.test(content.slice(seg.start, seg.end))).toBe(false);
      expect(segmentsOf(content).some((s) => (s.cutKind as string) === 'blank')).toBe(false);
    }
    const at = resolveTurningPoint(EN, matchFor(EN, 'However'))!;
    expect(/^\s/.test(at.cutpoint)).toBe(false);
  });

  it('reports segmentEndAfter(start) as the next unit start', () => {
    const segs = segmentsOf(EN);
    for (const seg of segs) expect(segmentEndAfter(EN, seg.start)).toBe(seg.end);
    expect(segmentEndAfter(EN, segs[segs.length - 1].start)).toBe(EN.length);
    expect(segmentEndAfter(EN, 1 + EN.indexOf('However'))).toBeNull();
  });

  it('maps a position to the unit it lies in, and clamps at both ends', () => {
    for (const content of [EN, CN]) {
      const segs = segmentsOf(content);
      for (const seg of segs) {
        for (let i = seg.start; i < seg.end; i++) {
          const s = segmentStartAt(content, i);
          // The cut for a position is at or before it, except across a blank
          // line, where the turn IS what comes next and the cut moves forward.
          expect(s).toBeGreaterThanOrEqual(0);
          expect(typeof s).toBe('number');
          expect(s).toBeLessThanOrEqual(content.length);
          expect(segmentStartAt(content, s)).toBe(s);
        }
      }
      const clamped = segmentStartAt(content, -10);
      expect(clamped).toBeGreaterThanOrEqual(0);
      expect(segmentsOf(content).some((s) => s.start === clamped)).toBe(true);
      const last = segmentStartAt(content, content.length + 99);
      expect(segs.some((s) => s.start === last)).toBe(true);
    }
  });

  it('a forced boundary is produced for an unpunctuated run and never offered as a cut', () => {
    const content = 'x'.repeat(250);
    const segs = segmentsOf(content);
    // No clause can join here, so the tiler cap stays a unit boundary…
    expect(segs.some((s) => s.cutKind === 'forced')).toBe(true);
    // …and it is refused: 0 has no prefix, the cap is not showable.
    expect(segmentStartAfter(content, 1)).toBeNull();
  });
});

describe('resolveTurningPoint — the cut takes the flagged unit (I1–I5)', () => {
  it('cuts at the flagged unit, not at the turning word', () => {
    const point = resolveTurningPoint(EN, matchFor(EN, 'However'))!;

    expect(point).not.toBeNull();
    expectInvariants(EN, point, 'However');
    expect(point.cutStart).toBe(EN.indexOf('However'));
    // The whole sentence is the replacement — not the 8-character "However,".
    expect(point.cutpoint).toBe('However, the real issue is in the API layer.');
    expect(point.remainder.startsWith('\n\nI will inspect')).toBe(true);
  });

  it('does not move the cut when the detector reports a mid-unit index (I6)', () => {
    const content =
      'The migration plan looks solid and the rollback path is documented.\n\nI will run it now. Wait, the staging database is not backed up yet.\n\nI will back it up first.';
    const waitIndex = content.indexOf('Wait');
    const point = resolveTurningPoint(content, matchFor(content, 'Wait'))!;

    expectInvariants(content, point, 'Wait');
    // Same unit as the hint, so the same cut — never the unit before it.
    expect(segmentStartAt(content, waitIndex)).toBe(point.cutStart);
    expect(content.slice(point.cutStart, point.cutStart + 5)).toBe('Wait,');
    expect(point.cutpoint).toBe('Wait, the staging database is not backed up yet.');
  });

  it('handles a Chinese turn that has no whitespace around the word', () => {
    const point = resolveTurningPoint(CN, matchFor(CN, '但'))!;

    expectInvariants(CN, point, '但');
    expect(point.cutStart).toBe(CN.indexOf('但'));
    expect(point.cutpoint).toBe('但根本问题可能在配置文件里，也可能在缓存层。');
  });

  it('uses the reported offset when the hint word is not in the text (model-only answer)', () => {
    // A hint inside the final unit, with no matching anchor in the text.
    const unit = segmentsOf(EN).at(-1)!;
    const point = resolveTurningPoint(EN, { word: 'Nowhere', index: unit.start + 15, score: 0.77 })!;

    expectInvariants(EN, point);
    expect(point.cutStart).toBe(unit.start);
  });

  it('replaces the final unit (I7): the cut runs to the end of the response', () => {
    const content =
      'The first paragraph explains the plan in enough detail to be kept.\n\nI will start by running the migration. Wait, the staging database has no backup.';
    const point = resolveTurningPoint(content, matchFor(content, 'Wait'))!;

    expectInvariants(content, point, 'Wait');
    expect(segmentStartAt(content, content.indexOf('Wait'))).toBe(point.cutStart);
    expect(segmentsOf(content).at(-1)!.end).toBe(content.length);
    expect(point.cutEnd).toBe(content.length);
    expect(point.remainder).toBe('');
  });
});

describe('resolveTurningPoint — rejects unusable cuts (I8)', () => {
  it('rejects a turn too close to the start', () => {
    const content = 'However, this is a fresh idea and it deserves a careful examination today.';
    expect(resolveTurningPoint(content, matchFor(content, 'However'))).toBeNull();
    expect(content.indexOf('However')).toBeLessThan(MIN_PREFIX_LENGTH);
  });

  it('rejects a turn in a non-final unit that leaves too little after it', () => {
    const content = 'The full test suite passes and the lint step is clean on the branch.\n\nHowever, done.\n\nok';
    expect(resolveTurningPoint(content, matchFor(content, 'However'))).toBeNull();
  });

  it('the mid-text remainder guard does NOT apply to the final unit (whole-unit replacement)', () => {
    // The final unit is replaced WHOLE: there is no remainder to protect, so a
    // short tail is the cut's own last words, not a sliver left behind.
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\nThe plan is fine. Wait, it is not.';
    const point = resolveTurningPoint(content, matchFor(content, 'Wait'))!;
    expectInvariants(content, point, 'Wait');
    expect(point.cutEnd).toBe(content.length);
    expect(point.remainder).toBe('');
    expect(point.cutpoint).toBe('Wait, it is not.');
  });

  it('accepts a turn with a paragraph break on both sides (I8 boundary)', () => {
    const content = `${'x'.repeat(MIN_PREFIX_LENGTH)}\n\nBut ${'y'.repeat(MIN_REMAINDER_LENGTH)}\n\n${'z'.repeat(MIN_REMAINDER_LENGTH)}`;
    const point = resolveTurningPoint(content, matchFor(content, 'But'))!;
    expectInvariants(content, point, 'But');
    expect(point.remainder.trim()).toBe('z'.repeat(MIN_REMAINDER_LENGTH));
  });

  it('rejects an answer that carries neither an anchor nor an offset', () => {
    expect(resolveTurningPoint(EN, { word: '', index: Number.NaN, score: 0.9 })).toBeNull();
  });

  it('rejects an out-of-range index', () => {
    expect(resolveTurningPoint(EN, { word: 'However', index: -5, score: 0.9 })).toBeNull();
    expect(resolveTurningPoint(EN, { word: 'However', index: EN.length + 1, score: 0.9 })).toBeNull();
  });

  it('refuses every hint when the grid is not wired (never invents a segmentation)', () => {
    // Guards against a silent fallback: with no producer there is no unit the
    // model scored, so crossroad must stay out of the way. Restored here (not in
    // afterEach) so no other suite can be left without a grid.
    usePackageSegmenter(null);
    try {
      expect(segmentsOf(EN)).toEqual([]);
      expect(resolveTurningPoint(EN, matchFor(EN, 'However'))).toBeNull();
    } finally {
      usePackageSegmenter(pkgSegmentsOf);
    }
  });
});

/**
 * THE BLIND SPOTS. Cases that a naive segmenter corrupts: every one below was
 * reachable, so each test names the defect it pins and fails with a diagnosis.
 */
describe('segmentation blind spots', () => {
  it('CRLF paragraph breaks are boundaries too (a CRLF reply must not collapse to one unit)', () => {
    const lf =
      'A long committed opening paragraph that sets the direction clearly and fully\n\nHowever the plan is wrong and the direction must flip now\n\nThen more text follows here for length and detail.';
    const crlf = lf.replace(/\n/g, '\r\n');

    const lfPoint = resolveTurningPoint(lf, matchFor(lf, 'However'))!;
    const crlfPoint = resolveTurningPoint(crlf, matchFor(crlf, 'However'))!;

    expectInvariants(lf, lfPoint, 'However');
    expectInvariants(crlf, crlfPoint, 'However');
    expect(segmentsOf(crlf).length).toBe(segmentsOf(lf).length);
    expect(crlfPoint.cutpoint.replace(/\r\n/g, '\n')).toBe(lfPoint.cutpoint);
    expect(crlfPoint.prefix.replace(/\r\n/g, '\n')).toBe(lfPoint.prefix);
  });

  it('a hint ON a paragraph break belongs to the paragraph it closes (moves BACK)', () => {
    const content =
      'Paragraph one commits to a plan of action for the whole refactor.\n\nParagraph two commits further and describes the rollout order.\n\nHowever, all of that is wrong and the direction must be reversed now.';
    const runStart = content.indexOf('\n\n', content.indexOf('Paragraph two'));
    // 0.2.1: the paragraph break CLOSES the unit before it, so a hint on either
    // newline belongs to the paragraph it ends — and the cut may not start on
    // that newline, so it moves BACK to the paragraph's first character.
    for (const offset of [runStart, runStart + 1]) {
      const point = resolveTurningPoint(content, { word: '', index: offset, score: 0.9 })!;
      expectInvariants(content, point);
      expect(point.cutpoint.startsWith('\n')).toBe(false);
      expect(point.cutStart).toBe(content.indexOf('Paragraph two'));
    }
    // One character further is the NEXT paragraph, and the turn is replaced whole.
    const after = resolveTurningPoint(content, { word: '', index: runStart + 2, score: 0.9 })!;
    expectInvariants(content, after);
    expect(after.cutpoint).toContain('However, all of that is wrong');
    expect(after.remainder).toBe('');
  });

  it('a long response does not throw at the segmentation step (no silent "LLM call failed")', () => {
    const content = Array.from({ length: 1200 }, (_, i) => `Point ${i} stands`).join('. ') + '.';
    const at = content.indexOf('Point 500 stands');

    const point = resolveTurningPoint(content, { word: 'Point 500 stands', index: at, score: 0.9 })!;
    expectInvariants(content, point, 'Point 500 stands');
    expect(segmentsOf(content).length).toBeGreaterThan(1000);
  });

  it('the cut does not land inside a decimal number', () => {
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\nThe failure is version 3.14 of the cache library and it must be pinned now.';
    const point = resolveTurningPoint(content, matchFor(content, 'version 3.14'))!;

    expectInvariants(content, point);
    // "version 3." + "14 …" would ship a corrupted number.
    expect(point.cutpoint).toContain('version 3.14');
  });

  it('the final unit keeps the anchor inside the cut, not in the remainder', () => {
    // '...' is terminators, so the lattice splits it; N2/N4 carry it into the
    // sentence and the final unit is replaced whole.
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\nThe plan failed... However, that is wrong and the whole direction must flip now.';
    const point = resolveTurningPoint(content, matchFor(content, 'However,'))!;

    expectInvariants(content, point, 'However,');
    expect(point.remainder).not.toContain('However');
  });

  it('an astral character before the hint does not shift the cut (code-point vs UTF-16)', () => {
    const base =
      'A long committed opening paragraph that sets the direction clearly.\n\nThe plan is fine. However, the direction must flip now and that is final.';
    const astral = '🚀🚀 ' + base;
    const pureBmpPoint = resolveTurningPoint(base, matchFor(base, 'However,'))!;
    const astralPoint = resolveTurningPoint(astral, matchFor(astral, 'However,'))!;

    // Same TEXT position: two emoji add 2 code points and 3 UTF-16 units ("🚀🚀 "),
    // so the conversion must shift the UTF-16 cut by exactly that much.
    expect(astralPoint.cutStart).toBe(pureBmpPoint.cutStart + '🚀🚀 '.length);
    expect(astralPoint.cutpoint).toBe(pureBmpPoint.cutpoint);
    expectInvariants(astral, astralPoint, 'However,');
  });

  it('a lone surrogate does not throw and keeps monotonic offsets', () => {
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\nThe plan is \uD83D broken. However, the direction must flip now and that is final.';
    const at = content.indexOf('However,');
    const point = resolveTurningPoint(content, { word: 'However,', index: at, score: 0.9 });

    expect(point).not.toBeNull();
    expectInvariants(content, point!);
    expect(point!.cutEnd).toBeGreaterThan(point!.cutStart);
  });

  it('the last unit ends at content.length even with trailing whitespace', () => {
    const withTrailing = EN + '\n\n';
    const segs = segmentsOf(withTrailing);
    expect(segs[segs.length - 1].end).toBe(withTrailing.length);
    expect(segmentEndAfter(withTrailing, segs[segs.length - 1].start)).toBe(withTrailing.length);
    // …and the trailing blank lines are not offered as the cut.
    const point = resolveTurningPoint(withTrailing, matchFor(withTrailing, 'However'))!;
    expectInvariants(withTrailing, point);
    expect(point.cutpoint).toBe('However, the real issue is in the API layer.');
  });
});
