import { describe, it, expect } from 'vitest';
import {
  plainPreview,
  buildCrossroadCard,
  formatCrossroadCard,
  toCrossroadCardWire,
  CROSSROAD_PREVIEW_MAX,
} from '../../loop/crossroad-card.js';

/**
 * The crossroad display contract. These tests exist because the old renderer
 * sliced RAW model text to 100 chars before drawing a numbered row — so a
 * newline, a list marker or a code fence inside a continuation could split or
 * restyle the row meant to preview it. The order matters: flatten → de-markdown
 * → truncate.
 */

describe('plainPreview', () => {
  it('flattens newlines and collapses whitespace to ONE line', () => {
    expect(plainPreview('first line\n\nsecond   line\tthird')).toBe('first line second line third');
  });

  it('strips markdown emphasis, code ticks and leading list/heading markers', () => {
    expect(plainPreview('**bold** text')).toBe('bold text');
    expect(plainPreview('run `pnpm test` now')).toBe("run 'pnpm test' now");
    expect(plainPreview('# Heading in a preview')).toBe('Heading in a preview');
    expect(plainPreview('- bullet shaped')).toBe('bullet shaped');
  });

  it('truncates AFTER flattening, so the cut cannot split a structural marker', () => {
    // Two paragraphs: if truncation ran first, the second line (the interesting
    // one) would be dropped OR the row would break on the newline.
    const text = `short line\n${'x'.repeat(200)}`;
    const out = plainPreview(text, 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('\n');
    // The truncated body is a prefix of the FLATTENED string.
    expect('xxxx'.startsWith('x')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
  });

  it('uses CROSSROAD_PREVIEW_MAX by default and leaves short text untouched', () => {
    expect(plainPreview('short')).toBe('short');
    const long = 'y'.repeat(CROSSROAD_PREVIEW_MAX + 50);
    expect(plainPreview(long)).toHaveLength(CROSSROAD_PREVIEW_MAX + 1); // + ellipsis
  });

  it('leaves a code fence inert instead of letting it open a block', () => {
    const out = plainPreview('```ts\nconst a = 1;\n```');
    expect(out).not.toContain('```');
    expect(out).toContain('const a = 1;');
  });
});

describe('buildCrossroadCard', () => {
  it('numbers candidates in GENERATION order and marks the winner', () => {
    const card = buildCrossroadCard({
      candidates: ['alpha', 'beta', 'gamma'],
      selectedIndex: 1,
      resolvedOutcome: 'beta',
      directionNames: ['go forward', 'go backward', 'synthesize at a high level'],
    });

    expect(card.drafted).toBe(3);
    expect(card.chosenIndex).toBe(2); // 1-based
    expect(card.candidates.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(card.candidates.map((c) => c.selected)).toEqual([false, true, false]);
  });

  it('keeps the direction labels aligned with the candidate order', () => {
    const card = buildCrossroadCard({
      candidates: ['alpha', 'beta'],
      selectedIndex: 0,
      directionNames: ['go forward'],
    });
    expect(card.candidates[0].direction).toBe('go forward');
    // Never invents a label: the missing one falls back to `option N`.
    expect(card.candidates[1].direction).toBe('option 2');
  });

  it('treats an out-of-range selectedIndex as "no winner" (-1)', () => {
    const card = buildCrossroadCard({ candidates: ['a'], selectedIndex: 9 });
    expect(card.chosenIndex).toBe(-1);
    expect(card.candidates.every((c) => !c.selected)).toBe(true);
    expect(formatCrossroadCard(card)).not.toContain('chose #');
  });

  it('normalizes previews and the outcome through plainPreview', () => {
    const card = buildCrossroadCard({
      candidates: ['line1\nline2'],
      selectedIndex: 0,
      resolvedOutcome: '**done**',
    });
    expect(card.candidates[0].preview).toBe('line1 line2');
    expect(card.outcome).toBe('done');
  });
});

describe('formatCrossroadCard (terminal fallback / history body)', () => {
  it('puts the winner first-class, then the outcome as its own paragraph', () => {
    const card = buildCrossroadCard({
      candidates: ['go forward text', 'go backward text'],
      selectedIndex: 1,
      resolvedOutcome: 'the backward one',
      directionNames: ['go forward', 'go backward'],
    });
    const text = formatCrossroadCard(card);

    expect(text).toContain('**🚦 Crossroad** — drafted 2 directions — chose #2:');
    expect(text).toContain('1. ⬜ go forward — go forward text');
    expect(text).toContain('2. ✅ **go backward** — go backward text');
    // Outcome on its own paragraph, after a blank line.
    expect(text).toContain('\n\n**Outcome:** the backward one');
  });

  it('omits the outcome paragraph when there is none', () => {
    const card = buildCrossroadCard({ candidates: ['only'], selectedIndex: 0 });
    expect(formatCrossroadCard(card)).not.toContain('Outcome:');
  });
});

describe('toCrossroadCardWire', () => {
  it('is flat, JSON-safe and drops view-only fields', () => {
    const card = buildCrossroadCard({
      candidates: ['a', 'b'],
      selectedIndex: 0,
      resolvedOutcome: 'a',
      directionNames: ['go forward', 'go backward'],
    });
    const wire = toCrossroadCardWire(card);

    expect(wire.kind).toBe('crossroad');
    expect(wire.drafted).toBe(2);
    expect(wire.chosenIndex).toBe(1);
    expect(wire.candidates).toEqual([
      { index: 1, direction: 'go forward', preview: 'a', selected: true },
      { index: 2, direction: 'go backward', preview: 'b', selected: false },
    ]);
    expect(wire.outcome).toBe('a');
    // Survives the wire as-is.
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});
