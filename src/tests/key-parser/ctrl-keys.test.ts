import { describe, it, expect } from 'vitest';
import {
  parseKeys,
  isCtrlC,
  isEscape,
  KeyInfo,
} from '../../utils/key-parser';

/**
 * Helper to create a buffer from hex values
 */
function hexBuf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('key-parser', () => {
  describe('Ctrl Key Detection', () => {
    describe('isCtrlC', () => {
      it('should return true for Ctrl+C', () => {
        expect(isCtrlC(hexBuf(0x03))).toBe(true);
      });

      it('should return false for other keys', () => {
        expect(isCtrlC(hexBuf(0x01))).toBe(false);
        expect(isCtrlC(hexBuf(0x04))).toBe(false);
        expect(isCtrlC(hexBuf(0x61))).toBe(false);
      });

      it('should return false for multi-byte buffers', () => {
        expect(isCtrlC(hexBuf(0x03, 0x00))).toBe(false);
      });

      it('should return false for empty buffer', () => {
        expect(isCtrlC(hexBuf())).toBe(false);
      });
    });

    describe('isEscape', () => {
      it('should return true for ESC key alone', () => {
        expect(isEscape(hexBuf(0x1b))).toBe(true);
      });

      it('should return false for escape sequences', () => {
        expect(isEscape(hexBuf(0x1b, 0x5b, 0x41))).toBe(false);
      });

      it('should return false for other keys', () => {
        expect(isEscape(hexBuf(0x03))).toBe(false);
        expect(isEscape(hexBuf(0x61))).toBe(false);
      });

      it('should return false for empty buffer', () => {
        expect(isEscape(hexBuf())).toBe(false);
      });
    });

    describe('Ctrl+A through Ctrl+Z', () => {
      it('should parse Ctrl+A (0x01)', () => {
        const result = parseKeys(hexBuf(0x01));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'a',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'a',
        });
      });

      it('should parse Ctrl+B (0x02)', () => {
        const result = parseKeys(hexBuf(0x02));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'b',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'b',
        });
      });

      it('should parse Ctrl+D (0x04) - EOF', () => {
        const result = parseKeys(hexBuf(0x04));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'd',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'd',
        });
      });

      it('should parse Ctrl+E (0x05)', () => {
        const result = parseKeys(hexBuf(0x05));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'e',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'e',
        });
      });

      it('should parse Ctrl+G (0x07) - Bell', () => {
        const result = parseKeys(hexBuf(0x07));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'g',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'g',
        });
      });

      it('should parse Ctrl+H (0x08) - should be backspace, not ctrl+h', () => {
        // Note: 0x08 is backspace in the implementation
        const result = parseKeys(hexBuf(0x08));
        expect(result[0].name).toBe('backspace');
      });

      it('should parse Ctrl+I (0x09) - Tab', () => {
        const result = parseKeys(hexBuf(0x09));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'i',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'i',
        });
      });

      it('should parse Ctrl+J (0x0a) - should be return, not ctrl+j', () => {
        // Note: 0x0a is treated as return in the implementation
        const result = parseKeys(hexBuf(0x0a));
        expect(result[0].name).toBe('return');
      });

      it('should parse Ctrl+K (0x0b)', () => {
        const result = parseKeys(hexBuf(0x0b));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'k',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'k',
        });
      });

      it('should parse Ctrl+L (0x0c)', () => {
        const result = parseKeys(hexBuf(0x0c));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'l',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'l',
        });
      });

      it('should parse Ctrl+M (0x0d) - should be return, not ctrl+m', () => {
        // Note: 0x0d is treated as return in the implementation
        const result = parseKeys(hexBuf(0x0d));
        expect(result[0].name).toBe('return');
      });

      it('should parse Ctrl+N (0x0e)', () => {
        const result = parseKeys(hexBuf(0x0e));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'n',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'n',
        });
      });

      it('should parse Ctrl+P (0x10)', () => {
        const result = parseKeys(hexBuf(0x10));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'p',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'p',
        });
      });

      it('should parse Ctrl+Q (0x11)', () => {
        const result = parseKeys(hexBuf(0x11));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'q',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'q',
        });
      });

      it('should parse Ctrl+R (0x12)', () => {
        const result = parseKeys(hexBuf(0x12));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'r',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'r',
        });
      });

      it('should parse Ctrl+S (0x13)', () => {
        const result = parseKeys(hexBuf(0x13));
        expect(result[0]).toEqual<KeyInfo>({
          name: 's',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 's',
        });
      });

      it('should parse Ctrl+U (0x15)', () => {
        const result = parseKeys(hexBuf(0x15));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'u',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'u',
        });
      });

      it('should parse Ctrl+V (0x16)', () => {
        const result = parseKeys(hexBuf(0x16));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'v',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'v',
        });
      });

      it('should parse Ctrl+W (0x17)', () => {
        const result = parseKeys(hexBuf(0x17));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'w',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'w',
        });
      });

      it('should parse Ctrl+X (0x18)', () => {
        const result = parseKeys(hexBuf(0x18));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'x',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'x',
        });
      });

      it('should parse Ctrl+Y (0x19)', () => {
        const result = parseKeys(hexBuf(0x19));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'y',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'y',
        });
      });

      it('should parse Ctrl+Z (0x1a)', () => {
        const result = parseKeys(hexBuf(0x1a));
        expect(result[0]).toEqual<KeyInfo>({
          name: 'z',
          ctrl: true,
          meta: false,
          shift: false,
          sequence: 'z',
        });
      });
    });
  });
});