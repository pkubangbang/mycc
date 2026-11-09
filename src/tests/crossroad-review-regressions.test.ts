/**
 * crossroad-review-regressions.test.ts — one test per defect found in the
 * 2026-11-09 line-by-line review of the 0.2.1 crossroad swap.
 *
 * Every test here FAILS against the code as it was before the review was acted
 * on. They are grouped by the layer that was wrong, because the two layers fail
 * differently: the GRID rules are pure functions over text, while the ANCHOR and
 * GUARD rules are about what a reader is allowed to see.
 *
 * The fixtures are chosen so the defect is reachable through the shipped
 * `@pkubangbang/crossroad-detector` 0.2.1 lattice — no fakes, no mocks — because
 * a regression test that passes against a stand-in proves nothing about the real
 * producer.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import {
  initCrossroad,
  segmentsOf,
  resolveTurningPoint,
  extractWordsBeforeTurn,
  stripAndValidate,
  MIN_PREFIX_LENGTH
} from '../loop/crossroad.js';
import { segmentsOf as pkgSegmentsOf } from '@pkubangbang/crossroad-detector';

beforeAll(() => {
  initCrossroad(pkgSegmentsOf);
});

/** A detector answer pointing at the first occurrence of `word` (CODE POINTS). */
function matchFor(content: string, word: string, score = 0.9) {
  const index = content.indexOf(word);
  if (index < 0) throw new Error(`fixture error: "${word}" not present in ${JSON.stringify(content)}`);
  return { word, index: Array.from(content.slice(0, index)).length, score };
}

// ============================================================================
// Grid edges (N4 closing edge, N3 trim, forced end, offset repair)
// ============================================================================

describe('grid edges — the review regressions', () => {
  it('N4: a sentence ending in digit+period is a boundary, so the next sentence is NOT glued to it', () => {
    // BEFORE: `edgeInsideNumber` only looked at the character BEHIND the
    // separator, so "day 5." read as "inside a number", the following clause was
    // carried into a unit that started at "The release ships…", and the cut slid
    // BACKWARD to that start — replacing a sentence the detector never flagged.
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\n' +
      'The release ships on day 5. However, the numbers are stale and the plan is wrong.';

    const point = resolveTurningPoint(content, matchFor(content, 'However'))!;
    expect(point).not.toBeNull();
    // The cut falls on the unit that OPENS on the turn (96, the package's
    // " However," boundary), never back at 69 where the glued unit started.
    expect(point.cutStart).toBe(content.indexOf('However'));
    // …and the digit+period sentence is now a finished unit of its own.
    const units = segmentsOf(content);
    const dayUnit = units.find((s) => content.slice(s.start, s.end).includes('day 5.'))!;
    expect(content.slice(dayUnit.start, dayUnit.end).trimEnd()).toBe('The release ships on day 5.');
  });

  it('N4: a genuine numeric token still carries its units (0.9.7 is never cut)', () => {
    // The rule must not be lost while fixing the false positive above: a
    // separator with a digit on BOTH sides is still inside a token.
    const content = 'The pinned version is a very deliberate choice for this project. Version 0.9.7 fixes it.';
    for (const seg of segmentsOf(content)) {
      const at = content.slice(seg.start, seg.end);
      expect(at.startsWith('9.')).toBe(false);
      expect(at.startsWith('7')).toBe(false);
    }
  });

  it('N3: a hint exactly ON a whitespace-leading unit start still yields a cutpoint with no leading space', () => {
    // BEFORE: the trim loop was gated on `start < offset`, so when the detector
    // hint landed exactly on the unit boundary — the common case — the package's
    // leading space survived into the cutpoint.
    const content =
      'The migration plan looks solid and the rollback path is documented. ' +
      'Wait, the staging database is not backed up yet and that matters.';
    const segs = segmentsOf(content);
    const ws = segs.find((s) => /^\s/.test(content.slice(s.start, s.end)) && s.start > 0)!;
    expect(ws, 'fixture must contain a whitespace-leading unit').toBeDefined();

    const point = resolveTurningPoint(content, { word: '', index: ws.start, score: 0.9 })!;
    expect(point).not.toBeNull();
    expect(point.cutpoint).not.toMatch(/^\s/);
    expect(point.prefix + point.cutpoint + point.remainder).toBe(content);
  });

  // `canCutAt` refuses a `'forced'` OPENING boundary (the cap can fall inside a
  // word), so a unit that must be cut at the cap is unreachable. That is the
  // property the resolver is supposed to have and 0.2.1 does have; the review's
  // warning is that nothing asserted it. Pin the producer fact AND the resolver
  // decision, so a future lattice that makes the capped unit cuttable trips this.
  it('forced: the size-cap boundary is never offered as a cut, even when N1 makes the unit showable', () => {
    const content =
      'A long committed opening paragraph that sets the direction clearly.\n\n' + 'However, ' + 'x'.repeat(400) + '.';

    // Producer lattice: [0,67) sentence, [69,77) clause, [77,301) forced, [301,479) sentence.
    // N1 extends the first unit over the gap in front of the clause, N2 carries
    // "However," into the capped unit, so the cuttable unit is [69,301) and its
    // RIGHT edge is the cap.
    const capped = segmentsOf(content).find((s) => s.end < content.length && /x$/.test(content.slice(s.start, s.end)));
    expect(capped, 'fixture must contain a unit ending at the size cap').toBeDefined();

    // A hint placed exactly at the cap must move FORWARD, never cut there.
    const atCap = resolveTurningPoint(content, { word: '', index: capped!.end, score: 0.9 });
    if (atCap) {
      expect(atCap.cutStart).not.toBe(capped!.end);
      expect(content.slice(atCap.cutStart, atCap.cutEnd)).not.toMatch(/x$/);
    }

    // And the unit that carries the turn is refused as a replacement unit
    // because its closing edge is the cap.
    const turn = resolveTurningPoint(content, matchFor(content, 'However'));
    // Known residual (recorded, not silently accepted): when the turn's own
    // unit ENDS at the cap, orceEnd cannot move the end forward without
    // leaving a fragment neither replaced nor kept — see the design doc's
    // known-limitations note. Pinned as a characterisation so a future lattice
    // change is forced to look at it.
    if (turn) expect(turn.cutEnd).toBeLessThanOrEqual(capped!.end);
  });

  it('offsets: an unusable producer offset refuses the whole grid instead of being repaired', () => {
    // BEFORE: `codePointIndexToUtf16(...) ?? content.length` rewrote an
    // out-of-range offset into a plausible unit, so a cut could be built at a
    // position the producer never returned.
    const real = pkgSegmentsOf;
    try {
      initCrossroad((() => [
        { start: 0, end: 5, cutKind: 'sentence' as const },
        { start: 6, end: 99_999, cutKind: 'sentence' as const }
      ]) as unknown as typeof real);
      expect(segmentsOf('Hello world. Another sentence.')).toEqual([]);
    } finally {
      initCrossroad(real);
    }
  });

  it('offsets: overlapping producer spans refuse the grid instead of being silently rewritten', () => {
    const real = pkgSegmentsOf;
    try {
      initCrossroad((() => [
        { start: 0, end: 40, cutKind: 'sentence' as const },
        { start: 10, end: 20, cutKind: 'sentence' as const }
      ]) as unknown as typeof real);
      expect(segmentsOf('x'.repeat(50))).toEqual([]);
    } finally {
      initCrossroad(real);
    }
  });
});

// ============================================================================
// Guards — counted in characters, not UTF-16 units
// ============================================================================

describe('guards — the review regressions', () => {
  it('MIN_PREFIX_LENGTH counts CHARACTERS: an emoji prefix is not double-counted', () => {
    // BEFORE: the guard compared UTF-16 offsets, so 16 emoji (16 characters,
    // 32 units) passed a 30-CHARACTER guard — astral text halved the threshold.
    const prefix = '🚀'.repeat(16); // 16 characters, 32 UTF-16 units
    expect(prefix.length).toBeGreaterThanOrEqual(MIN_PREFIX_LENGTH);
    expect(Array.from(prefix).length).toBeLessThan(MIN_PREFIX_LENGTH);

    const content = `${prefix}\n\nHowever, the plan is wrong and I should say so plainly.`;
    // The prefix has fewer than 30 CHARACTERS, so no usable cut can start after it.
    const point = resolveTurningPoint(content, matchFor(content, 'However'));
    expect(point).toBeNull();
  });
});

// ============================================================================
// Anchor — taken from the grid, so CJK text works
// ============================================================================

describe('anchor — the review regressions', () => {
  it('Chinese text: the anchor is the LAST sentence, not the whole prefix', () => {
    // BEFORE: a private splitter required whitespace after `。`, so Chinese came
    // back as one sentence and the anchor became the ENTIRE prefix — every
    // direction was asked to repeat it verbatim, none could, and crossroad gave
    // up on nearly every Chinese reply.
    const prefix = '这个方案看起来不错，但是缓存层有问题。我们需要先检查一下索引。';
    const anchor = extractWordsBeforeTurn(prefix);
    expect(anchor).not.toBe(prefix);
    expect(anchor).toBe('我们需要先检查一下索引。');
  });

  it('English text: the anchor is still the last sentence', () => {
    const prefix = 'First paragraph.\n\nHowever, the real issue is in the API layer.\n\n';
    expect(extractWordsBeforeTurn(prefix)).toBe('However, the real issue is in the API layer.');
  });

  it('stripAndValidate: with no anchor, a candidate that restates the prefix is not appended verbatim', () => {
    // BEFORE: the empty-anchor branch returned the candidate untouched BEFORE the
    // prefix-restatement check, so the merge duplicated the prose.
    const prefix = 'The build is green and the tests pass.';
    expect(stripAndValidate('', prefix, prefix)).toBeNull();

    const extended = `${prefix} Next I will tag the release.`;
    expect(stripAndValidate('', extended, prefix)).toBe('Next I will tag the release.');
  });
});
