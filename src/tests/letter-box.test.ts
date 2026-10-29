/**
 * letter-box.test.ts - Letter-box rendering of the REAL module
 *
 * This replaces src/tests/utils/letter-box.test.ts, which imported nothing from
 * `src/`: it declared a local `wrapText()` ("we'll duplicate the logic here
 * since it's not exported") and asserted against that copy. `src/utils/letter-box.ts`
 * has no `wrapText` at all — the real behaviour is `stripInternalMarkup` +
 * `displayLetterBox`, which this file drives.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripInternalMarkup, displayLetterBox, setResultCallback } from '../../src/utils/letter-box.js';

let writes: string[] = [];
const originalWrite = process.stdout.write;

beforeEach(() => {
  writes = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  setResultCallback(null);
});

afterEach(() => {
  process.stdout.write = originalWrite;
  setResultCallback(null);
});

describe('stripInternalMarkup', () => {
  it.each([
    ['ASCII pipes', 'before <||DSML||tag>hidden</||DSML||tag> after', 'before  after'],
    ['fullwidth pipes', 'before <\uff5c\uff5cDSML\uff5c\uff5ctag>hidden</\uff5c\uff5cDSML\uff5c\uff5ctag> after', 'before  after'],
    ['mixed ASCII+fullwidth pipes', 'a <|\uff5cDSML|\uff5cTAG>x</\uff5c|DSML\uff5c|TAG> b', 'a  b'],
    ['uppercase tag name', 'a <||DSML||TAG>x</||DSML||TAG> b', 'a  b'],
  ])('strips %s tags and keeps surrounding text', (_label, input, expected) => {
    expect(stripInternalMarkup(input)).toBe(expected);
  });

  it('leaves ordinary text (and unpaired DSML words) untouched', () => {
    expect(stripInternalMarkup('plain text')).toBe('plain text');
    expect(stripInternalMarkup('DSML without tags')).toBe('DSML without tags');
    expect(stripInternalMarkup('')).toBe('');
  });
});

describe('displayLetterBox', () => {
  it('writes a three-line box and mirrors the stripped content to the callback', () => {
    const seen: string[] = [];
    setResultCallback((c) => seen.push(c));

    displayLetterBox('hello <||DSML||t>gone</||DSML||t> world');

    const out = writes.join('');
    expect(out.split('\n').length).toBeGreaterThanOrEqual(3);
    expect(out).toContain('hello  world');
    // The callback receives the STRIPPED text, never the raw markup.
    expect(seen).toEqual(['hello  world']);
    expect(out).not.toContain('DSML');
  });

  it('shows a friendly fallback when markup stripping leaves nothing', () => {
    const seen: string[] = [];
    setResultCallback((c) => seen.push(c));

    displayLetterBox('<||DSML||t>only markup</||DSML||t>');

    const out = writes.join('');
    expect(out).toContain('no displayable content');
    expect(seen).toEqual(['(no displayable content — internal markup was stripped)']);
  });

  it('renders a header carrying a HH:MM:SS timestamp', () => {
    displayLetterBox('tick');
    expect(writes.join('')).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('does not call the callback when none is registered', () => {
    expect(() => displayLetterBox('no callback')).not.toThrow();
    expect(writes.join('')).toContain('no callback');
  });
});
