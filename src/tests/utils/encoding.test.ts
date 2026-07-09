/**
 * encoding.test.ts - Unit tests for encoding utility functions
 */

import { describe, it, expect } from 'vitest';
import { stripBom, detectLineEnding, normalizeLineEndings, countReplacementChars } from '../../utils/encoding.js';

describe('stripBom', () => {
  it('should strip UTF-8 BOM from string start', () => {
    const withBom = '﻿' + 'Hello, World!';
    expect(stripBom(withBom)).toBe('Hello, World!');
  });

  it('should not modify string without BOM', () => {
    const withoutBom = 'Hello, World!';
    expect(stripBom(withoutBom)).toBe('Hello, World!');
  });

  it('should handle empty string', () => {
    expect(stripBom('')).toBe('');
  });

  it('should handle BOM-only string as empty', () => {
    expect(stripBom('﻿')).toBe('');
  });

  it('should handle CJK content with BOM', () => {
    const withBom = '﻿' + '你好世界';
    expect(stripBom(withBom)).toBe('你好世界');
  });

  it('should handle CJK content without BOM', () => {
    const withoutBom = '日本語テスト';
    expect(stripBom(withoutBom)).toBe('日本語テスト');
  });

  it('should only strip first BOM, not subsequent U+FEFF chars', () => {
    const content = '﻿' + 'text' + '﻿' + 'more';
    expect(stripBom(content)).toBe('text' + '﻿' + 'more');
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

  it('should return crlf when even one CRLF is present', () => {
    expect(detectLineEnding('line1\nline2\r\nline3')).toBe('crlf');
  });

  it('should handle CJK content with CRLF', () => {
    expect(detectLineEnding('你好\r\n世界')).toBe('crlf');
  });

  it('should handle CJK content with LF', () => {
    expect(detectLineEnding('한국어\nテスト')).toBe('lf');
  });

  it('should handle standalone CR as LF (not CRLF)', () => {
    // Standalone \r without \n is not CRLF
    expect(detectLineEnding('line1\rline2')).toBe('lf');
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

  it('should handle empty string', () => {
    expect(normalizeLineEndings('')).toBe('');
  });

  it('should convert standalone CR to LF', () => {
    expect(normalizeLineEndings('line1\rline2')).toBe('line1\nline2');
  });

  it('should handle CJK content with CRLF', () => {
    expect(normalizeLineEndings('你好\r\n世界')).toBe('你好\n世界');
  });

  it('should handle CJK content with mixed endings', () => {
    expect(normalizeLineEndings('라인1\r\n라인2')).toBe('라인1\n라인2');
  });

  it('should handle multiple consecutive CRLF', () => {
    expect(normalizeLineEndings('a\r\n\r\nb')).toBe('a\n\nb');
  });
});

describe('countReplacementChars', () => {
  it('should return 0 for clean ASCII text', () => {
    expect(countReplacementChars('hello world')).toBe(0);
  });

  it('should return 0 for clean CJK text', () => {
    expect(countReplacementChars('你好世界')).toBe(0);
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

  it('should count consecutive replacement characters', () => {
    expect(countReplacementChars('\uFFFD\uFFFD\uFFFD')).toBe(3);
  });

  it('should detect corruption in a realistic code snippet', () => {
    // Simulates a comment line where an em dash was corrupted to U+FFFD + '?'
    const corrupted = '      // Two adjacent bare tokens \uFFFD?"key value".';
    expect(countReplacementChars(corrupted)).toBe(1);
  });
});
