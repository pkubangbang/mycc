/**
 * serve-utils.test.ts - unit tests for stripAnsi (and later LAN-IP helpers)
 *
 * Covers the stripAnsi regex chain (test-strength dir-14 round-10 weakness 5):
 * the WebUI history/display layer consumes stripAnsi output, and the regex is
 * a high-regression area (CSI/SGR, OSC, and bare escape runs each matched by a
 * separate replace). These tests pin the contract for plain text, full SGR
 * sequences, and incomplete/truncated escape sequences.
 *
 * LAN-IP helpers (detectAllLanIpv4 / detectLanIpv4) depend on
 * os.networkInterfaces() and are environment-sensitive, so they are not
 * asserted here (would need interface injection and are CI-fragile).
 */
import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../serve/serve-utils.js';

describe('stripAnsi', () => {
  it('returns plain text unchanged', () => {
    expect(stripAnsi('plain')).toBe('plain');
    expect(stripAnsi('')).toBe('');
  });

  it('strips a full SGR color sequence (ESC[31m ... ESC[0m)', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips multiple SGR runs in one string', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[22m and \x1b[32mgreen\x1b[0m')).toBe('bold and green');
  });

  it('strips CSI cursor-move sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hclear')).toBe('clear');
  });

  it('strips OSC sequences terminated by BEL', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });

  it('strips OSC sequences terminated by ST (ESC backslash)', () => {
    expect(stripAnsi('\x1b]0;title\x1b\\rest')).toBe('rest');
  });

  it('strips bare two-char escape runs (ESC + letter)', () => {
    expect(stripAnsi('\x1bMabc')).toBe('abc');
  });

  it('leaves a truncated CSI fragment (no terminator) as-is', () => {
    // ESC[3 with no terminating letter is an incomplete sequence; the CSI
    // regex requires a terminator char, so it is NOT stripped. Pin this so a
    // future "greedy" regex change that eats unterminated fragments is caught.
    expect(stripAnsi('\x1b[3')).toBe('\x1b[3');
  });

  it('handles mixed ansi and plain text across line breaks', () => {
    expect(stripAnsi('\x1b[33mwarn\x1b[0m\nnext')).toBe('warn\nnext');
  });
});