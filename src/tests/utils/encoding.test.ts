/**
 * encoding.test.ts - Unit tests for encoding utility functions
 */

import { describe, it, expect } from 'vitest';
import { stripBom, detectLineEnding, normalizeLineEndings, applyLineEndings, hasBom, countReplacementChars } from '../../utils/encoding.js';

describe('stripBom', () => {
  it('should strip UTF-8 BOM from string start', () => {
    const withBom = '﻿' + 'Hello, World!';
    expect(stripBom(withBom)).toBe('Hello, World!');
  });

  it('should not modify string without BOM', () => {
    const withoutBom = 'Hello, World!';
    expect(stripBom(withoutBom)).toBe('Hello, World!');
  });





});

describe('detectLineEnding', () => {
  it('should return crlf for CRLF content', () => {
    expect(detectLineEnding('line1\r\nline2')).toBe('crlf');
  });

  it('should return lf for LF-only content', () => {
    expect(detectLineEnding('line1\nline2')).toBe('lf');
  });

  it('should return lf for empty content', () => {
    expect(detectLineEnding('')).toBe('lf');
  });




});

describe('normalizeLineEndings', () => {
  it('should convert CRLF to LF', () => {
    expect(normalizeLineEndings('line1\r\nline2')).toBe('line1\nline2');
  });

  it('should not modify LF-only content', () => {
    expect(normalizeLineEndings('line1\nline2')).toBe('line1\nline2');
  });

  it('should handle mixed line endings', () => {
    expect(normalizeLineEndings('line1\r\nline2\nline3\r\nline4'))
      .toBe('line1\nline2\nline3\nline4');
  });





});

describe('applyLineEndings', () => {
  it('should convert CRLF to LF when style is lf', () => {
    expect(applyLineEndings('line1\r\nline2', 'lf')).toBe('line1\nline2');
  });

  it('should leave LF-only content unchanged when style is lf', () => {
    expect(applyLineEndings('line1\nline2', 'lf')).toBe('line1\nline2');
  });



  it('should NOT double-convert CRLF to CR+CR+LF when style is crlf', () => {
    // The key correctness property: CRLF -> CRLF (not \r\r\n)
    expect(applyLineEndings('a\r\nb', 'crlf')).toBe('a\r\nb');
  });

  it('should normalize mixed line endings to LF', () => {
    expect(applyLineEndings('line1\r\nline2\nline3\r\nline4', 'lf'))
      .toBe('line1\nline2\nline3\nline4');
  });









});

describe('hasBom', () => {
  it('should return true for a string starting with U+FEFF', () => {
    expect(hasBom('\uFEFF' + 'Hello')).toBe(true);
  });

  it('should return false for a string without BOM', () => {
    expect(hasBom('Hello')).toBe(false);
  });



  it('should return false when U+FEFF appears mid-string but not at start', () => {
    expect(hasBom('text\uFEFFmore')).toBe(false);
  });

});

describe('countReplacementChars', () => {
  it('should return 0 for clean ASCII text', () => {
    expect(countReplacementChars('hello world')).toBe(0);
  });


  it('should count a single U+FFFD replacement character', () => {
    expect(countReplacementChars('foo\uFFFDbar')).toBe(1);
  });

  it('should count multiple U+FFFD replacement characters', () => {
    expect(countReplacementChars('\uFFFDfoo\uFFFDbar\uFFFD')).toBe(3);
  });

  it('should return 0 for empty string', () => {
    expect(countReplacementChars('')).toBe(0);
  });

  it('should not count other non-ASCII characters as replacement chars', () => {
    // Em dash (U+2014), CJK, emoji are NOT replacement chars
    expect(countReplacementChars('—你好😀')).toBe(0);
  });


});
