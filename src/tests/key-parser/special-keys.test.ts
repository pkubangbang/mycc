import { describe, it, expect } from 'vitest';
import { parseKeys, KeyInfo } from '../../utils/key-parser';

/**
 * Helper to create a buffer from hex values
 */
function hexBuf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('key-parser', () => {
  describe('Special Keys', () => {
    it('should parse Enter/Return (0x0d)', () => {
      const result = parseKeys(hexBuf(0x0d));
      expect(result[0]).toEqual<KeyInfo>({
        name: 'return',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '\r',
      });
    });

    it('should parse Enter/Return (0x0a - newline)', () => {
      const result = parseKeys(hexBuf(0x0a));
      expect(result[0]).toEqual<KeyInfo>({
        name: 'return',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '\r',
      });
    });

    it('should parse Backspace (0x7f - DEL)', () => {
      const result = parseKeys(hexBuf(0x7f));
      expect(result[0]).toEqual<KeyInfo>({
        name: 'backspace',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '\x7f',
      });
    });

    it('should parse Backspace (0x08 - BS)', () => {
      const result = parseKeys(hexBuf(0x08));
      expect(result[0]).toEqual<KeyInfo>({
        name: 'backspace',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '\x7f',
      });
    });

    it('should parse ESC key alone', () => {
      const result = parseKeys(hexBuf(0x1b));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'escape',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '\x1b',
      });
    });

    it('should parse Tab (0x09)', () => {
      const result = parseKeys(hexBuf(0x09));
      expect(result[0].ctrl).toBe(true);
      expect(result[0].name).toBe('i');
    });
  });

  describe('Printable ASCII Characters', () => {
    it('should parse lowercase letters', () => {
      const result = parseKeys(Buffer.from('abc'));
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'a',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: 'a',
      });
      expect(result[1]).toEqual<KeyInfo>({
        name: 'b',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: 'b',
      });
      expect(result[2]).toEqual<KeyInfo>({
        name: 'c',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: 'c',
      });
    });

    it('should parse uppercase letters with shift flag', () => {
      const result = parseKeys(Buffer.from('ABC'));
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'a',
        ctrl: false,
        meta: false,
        shift: true,
        sequence: 'A',
      });
      expect(result[1]).toEqual<KeyInfo>({
        name: 'b',
        ctrl: false,
        meta: false,
        shift: true,
        sequence: 'B',
      });
      expect(result[2]).toEqual<KeyInfo>({
        name: 'c',
        ctrl: false,
        meta: false,
        shift: true,
        sequence: 'C',
      });
    });

    it('should parse numbers', () => {
      const result = parseKeys(Buffer.from('123'));
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('');
      expect(result[0].sequence).toBe('1');
      expect(result[0].shift).toBe(false);
    });

    it('should parse space', () => {
      const result = parseKeys(hexBuf(0x20));
      expect(result[0].name).toBe('');
      expect(result[0].sequence).toBe(' ');
    });

    it('should parse special characters', () => {
      const result = parseKeys(Buffer.from('!@#$%'));
      expect(result).toHaveLength(5);
      expect(result[0].sequence).toBe('!');
      expect(result[1].sequence).toBe('@');
      expect(result[2].sequence).toBe('#');
      expect(result[3].sequence).toBe('$');
      expect(result[4].sequence).toBe('%');
    });
  });
});