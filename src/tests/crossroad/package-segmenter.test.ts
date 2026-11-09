/**
 * package-segmenter.test.ts — the cut grid is the detector package's, and only
 * the package's.
 *
 * Two things here can silently corrupt every cut, so both are pinned against
 * the REAL `@pkubangbang/crossroad-detector` (0.2.0) rather than a fake:
 *
 *   1. UNITS. Package segments are CODE-POINT offsets; mycc slices in UTF-16.
 *      The conversion must happen exactly once, and every offset must slice
 *      real text (never land inside a surrogate pair).
 *   2. cutKind. The package names a segment after the boundary that CLOSES it;
 *      mycc cuts at the boundary that OPENS one. A `'forced'` boundary — the
 *      producer's size cap, which may fall mid-word — must never be usable.
 *
 * There is deliberately NO fallback test: when the grid cannot be produced the
 * resolver refuses to cut rather than segmenting on units nothing scored.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import {
  segmentsOf,
  usePackageSegmenter,
  initCrossroad,
  resolveTurningPoint,
  type PkgSegment
} from '../../loop/crossroad.js';
import { createSegmenter, segmentsOf as pkgSegmentsOf } from '@pkubangbang/crossroad-detector';

beforeAll(() => {
  initCrossroad(pkgSegmentsOf);
});

const EN =
  'First paragraph of the answer.\n\nHowever, the real issue is in the API layer.\n\nI will inspect the router next.';

describe('segmentsOf — the package grid, in UTF-16 offsets', () => {
  it('is a PARTITION of the text (N1): ascending, contiguous, zero-to-end', () => {
    // `segmentsOf` is the CONSUMER view, not the raw package output: the raw
    // lattice drops whitespace-only parts and an unemitted whitespace tail, so
    // contiguous coverage here is produced by N1 and MUST NOT be asserted of the
    // package itself (see the raw-lattice tests below).
    for (const content of [EN, 'Alpha beta. Gamma delta. Epsilon zeta.', '一二三。四五六！']) {
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

  it('joins a clause-closed segment into its sentence (the unit the model scored)', () => {
    // "However," is closed by a clause comma → the FOLLOWING segment opens at a
    // clause boundary. The first segment opens at the text start.
    const segs = segmentsOf(EN);
    expect(segs[0].cutKind).toBe('sentence');
    // "However," is closed by a comma in the package; as a UNIT it is the whole
    // sentence, so no cut can ever land on 8 characters the model never judged.
    const however = segs.find((s) => EN.slice(s.start, s.end).startsWith('However'))!;
    // 0.2.1 has no blank-line units, so the sentence unit also carries the
    // paragraph break that closes it — the trim (N3) is what keeps that out of the
    // cutpoint, not the grid.
    expect(EN.slice(however.start, however.end)).toBe('However, the real issue is in the API layer.\n\n');
    expect(however.cutKind).toBe('sentence');
    expect(segs.some((s) => s.start === however.end)).toBe(true);
  });

  it('converts CODE-POINT offsets to UTF-16 exactly once (astral characters)', () => {
    const content = '🚀🚀 Alpha beta.\n\nGamma delta. 🚀 Epsilon zeta.';
    const segs = segmentsOf(content);
    expect(segs.length).toBeGreaterThan(0);
    // No offset may land inside a surrogate pair, and the pieces must rejoin.
    expect(segs.map((s) => content.slice(s.start, s.end)).join('')).toBe(content);
    expect(segs[segs.length - 1].end).toBe(content.length);
  });

  it('produces a size-cap boundary for an unpunctuated run, and mycc refuses it', () => {
    // The package tiles a 250-character clause at its cap; that boundary is
    // 'forced' and lands mid-word ("…xxx|xxx…").
    const content = 'x'.repeat(250);
    const segs = segmentsOf(content);
    expect(segs.length).toBe(2);
    expect(content.slice(segs[0].start, segs[0].end)).toHaveLength(224);
    expect(segs[1].cutKind).toBe('forced');
  });

  it('an unshowable lattice still becomes a partition: gaps are filled', () => {
    // The trainer drops whitespace-only parts, so the raw lattice has holes and a
    // document tail of whitespace is not emitted at all. A cut consumer cannot
    // treat "no unit here" as "nothing to cut", so `segmentsOf` fills the gaps.
    const content = 'Alpha beta.\n\nGamma delta.   ';
    usePackageSegmenter(() => [
      { start: 0, end: 11, cutKind: 'sentence' },
      { start: 13, end: 25, cutKind: 'sentence' }
    ]);
    try {
      const segs = segmentsOf(content);
      expect(segs[0].start).toBe(0);
      expect(segs[segs.length - 1].end).toBe(content.length);
      // The gap between the two units (the blank line, dropped by the trainer) is
      // now covered by the unit before it, so the units tile the text: the
      // second unit starts where the first one ends, not at its raw start.
      expect(segs[1].start).toBe(13);
      expect(segs[0].end).toBe(13);
      for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
      expect(segs.map((s) => content.slice(s.start, s.end)).join('')).toBe(content);
    } finally {
      usePackageSegmenter(pkgSegmentsOf);
    }
  });

  it('a boundary inside a numeric token is never a cut point', () => {
    // `_SENT_SPLIT` is a plain look-behind, so "0.9.7" is three segments. That is
    // the right lattice for the model's spans, but a cut at "9." would replace a
    // fragment of a version number — the consumer joins the token instead.
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\nThe fix lands in version 0.9.7 and the release is today.';
    usePackageSegmenter(() => {
      const paraEnd = content.indexOf('\n\n') + 2;
      const dot1 = content.indexOf('.', content.indexOf('version ')) + 1;
      const dot2 = content.indexOf('.', dot1) + 1;
      return [
        { start: 0, end: paraEnd, cutKind: 'sentence' as const },
        { start: paraEnd, end: dot1, cutKind: 'sentence' as const },
        { start: dot1, end: dot2, cutKind: 'sentence' as const },
        { start: dot2, end: content.length, cutKind: 'sentence' as const }
      ];
    });
    try {
      const segs = segmentsOf(content);
      const unit = segs.find((s) => content.slice(s.start, s.end).includes('0.9.7'))!;
      expect(content.slice(unit.start, unit.end)).toBe('The fix lands in version 0.9.7 and the release is today.');
      const point = resolveTurningPoint(content, {
        word: '9',
        index: Array.from(content.slice(0, content.indexOf('9.7'))).length,
        score: 0.9
      })!;
      expect(point.cutpoint).toBe('The fix lands in version 0.9.7 and the release is today.');
      expect(point.cutpoint).not.toMatch(/^9\./);
    } finally {
      usePackageSegmenter(pkgSegmentsOf);
    }
  });

  it('the RAW 0.2.1 lattice IS the trainer lattice: spans, clause label, no tiling', () => {
    // The swap protocol for the installed 0.2.1, pinned now so the swap cannot be
    // judged by the wrong test. On 0.2.0 the raw lattice is a different object:
    // every newline is its own span and the clause is split. On 0.2.1 it becomes
    // the trainer's `(0,30)(32,40)(40,76)(78,109)` with `cutKind` sentence/clause/
    // sentence/sentence — AT WHICH POINT THIS TEST MUST BE REWRITTEN, and the
    // other one below (which asserts the consumer view) must not move.
    const raw = pkgSegmentsOf(EN);
    // The trainer grid, exactly: the paragraph breaks are in NO span.
    expect(raw.map((s) => [s.start, s.end])).toEqual([
      [0, 30],
      [32, 40],
      [40, 76],
      [78, EN.length]
    ]);
    // The label is the ONLY trainer signal that survives N2's clause carry:
    // every user-visible cut is identical whether it reads clause or sentence,
    // so a port that reports sentence at [32,40) has drifted invisibly.
    expect(raw.map((s) => s.cutKind)).toEqual(['sentence', 'clause', 'sentence', 'sentence']);
    // BOUNDARY LEGALITY — the invariant that catches a port which ADDS a rule:
    // every span ends on a _SENT_SPLIT character, and no span starts inside a
    // numeric token.
    for (const s of raw) expect(EN[s.end - 1]).toMatch(/^[.!?,;:\\n。！？，；：]$/);
    for (const s of raw) {
      const before = EN[s.start - 2];
      if (before && /\\d/.test(before)) expect(EN[s.start - 1]).not.toMatch(/^[.,;:]$/);
    }
    // The raw lattice is NOT a partition (N1 supplies coverage), and this fixture
    // does not rejoin — a fact about THIS text, not a package invariant.
    expect(raw.map((s) => EN.slice(s.start, s.end)).join('')).not.toBe(EN);
  });

  it('is empty when no grid producer is wired (refuse, never invent)', () => {
    usePackageSegmenter(null);
    try {
      expect(segmentsOf(EN)).toEqual([]);
    } finally {
      usePackageSegmenter((text, opts) => createSegmenter(opts).push(text));
    }
  });

  it('honours the producer it is given (offsets still become UTF-16)', () => {
    // A producer that speaks code points, like the package: two emoji before
    // the boundary make code-point and UTF-16 offsets diverge by 2.
    const content = '🚀🚀 Alpha beta.';
    usePackageSegmenter((): PkgSegment[] => [
      { start: 0, end: 3, cutKind: 'sentence' },
      { start: 3, end: Array.from(content).length, cutKind: 'sentence' }
    ]);
    try {
      const segs = segmentsOf(content);
      expect(segs.map((s) => content.slice(s.start, s.end)).join('')).toBe(content);
      expect(segs[1].start).toBe('🚀🚀 '.length);
    } finally {
      usePackageSegmenter((text, opts) => createSegmenter(opts).push(text));
    }
  });
});
