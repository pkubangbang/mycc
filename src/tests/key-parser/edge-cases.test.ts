import { describe, it, expect } from 'vitest';
import { parseKeys } from '../../utils/key-parser';

/**
 * Helper to create a buffer from hex values
 */
function hexBuf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('key-parser', () => {
  describe('Edge Cases', () => {
    describe('Empty and Minimal Buffers', () => {
      it('should handle empty buffer', () => {
        expect(parseKeys(hexBuf())).toEqual([]);
      });

      it('should handle single byte 0x00', () => {
        const result = parseKeys(hexBuf(0x00));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('\\x00');
      });
    });

    describe('Unknown/Invalid Sequences', () => {
      it('should handle unknown escape sequence starting with ESC [', () => {
        // ESC [ Z (unknown sequence) - ESC[ followed by 'Z' (0x5a)
        // The parser doesn't recognize this sequence, so it returns:
        // - escape for ESC (0x1b)
        // - '[' as a character (0x5b)
        // - 'Z' as a character (0x5a)
        const result = parseKeys(hexBuf(0x1b, 0x5b, 0x5a));
        expect(result).toHaveLength(3);
        expect(result[0].name).toBe('escape');
        expect(result[1].sequence).toBe('[');
        expect(result[2].name).toBe('z');
        expect(result[2].shift).toBe(true);
      });

      it('should handle unknown escape sequence starting with ESC O', () => {
        // ESC O X (unknown sequence) - ESC O followed by 'X' (0x58)
        // The parser doesn't recognize this sequence, so it returns:
        // - escape for ESC (0x1b)
        // - 'O' as a character (0x4f)
        // - 'X' as a character (0x58)
        const result = parseKeys(hexBuf(0x1b, 0x4f, 0x58));
        expect(result).toHaveLength(3);
        expect(result[0].name).toBe('escape');
        expect(result[1].sequence).toBe('O');
        expect(result[2].name).toBe('x');
        expect(result[2].shift).toBe(true);
      });

      it('should handle ESC followed by non-bracket character', () => {
        // ESC followed by 'a' (0x61)
        const result = parseKeys(hexBuf(0x1b, 0x61));
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('escape');
        expect(result[1].name).toBe('a');
      });
    });

    describe('Partial Sequences', () => {
      it('should handle ESC alone at end of buffer', () => {
        const result = parseKeys(hexBuf(0x1b));
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('escape');
      });

      it('should handle partial arrow sequence (ESC [ alone)', () => {
        // This is ESC followed by [ - which is an incomplete sequence
        // The parser doesn't have a match for just ESC [, so it returns:
        // - escape for ESC (0x1b)
        // - '[' as a character (0x5b)
        const result = parseKeys(hexBuf(0x1b, 0x5b));
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('escape');
        expect(result[1].sequence).toBe('[');
      });
    });

    describe('Mixed Content', () => {
      it('should parse escape sequence followed by regular keys', () => {
        // Up arrow followed by 'a'
        const result = parseKeys(hexBuf(0x1b, 0x5b, 0x41, 0x61));
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('up');
        expect(result[1].name).toBe('a');
      });

      it('should parse regular keys followed by escape sequence', () => {
        // 'a' followed by up arrow
        const result = parseKeys(hexBuf(0x61, 0x1b, 0x5b, 0x41));
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('a');
        expect(result[1].name).toBe('up');
      });

      it('should parse multiple escape sequences', () => {
        // Up arrow followed by down arrow
        const result = parseKeys(hexBuf(
          0x1b, 0x5b, 0x41,
          0x1b, 0x5b, 0x42
        ));
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('up');
        expect(result[1].name).toBe('down');
      });

      it('should parse UTF-8 mixed with ASCII', () => {
        // 'a' + '中' + 'b'
        const result = parseKeys(hexBuf(0x61, 0xe4, 0xb8, 0xad, 0x62));
        expect(result).toHaveLength(3);
        expect(result[0].name).toBe('a');
        expect(result[1].sequence).toBe('中');
        expect(result[2].name).toBe('b');
      });
    });

    describe('Invalid UTF-8', () => {
      it('should handle invalid UTF-8 continuation byte', () => {
        // 0x80 is a continuation byte without a leading byte
        const result = parseKeys(hexBuf(0x80));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('\\x80');
      });

      it('should handle incomplete UTF-8 sequence', () => {
        // Start of a 3-byte sequence (0xe4) without continuation bytes
        const result = parseKeys(hexBuf(0xe4));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('\\xe4');
      });

      it('should handle truncated multi-byte UTF-8', () => {
        // '中' is e4 b8 ad - truncated to just e4 b8
        // The TextDecoder with fatal: true throws for each byte that can't be decoded
        // So we get two separate hex escapes
        const result = parseKeys(hexBuf(0xe4, 0xb8));
        expect(result).toHaveLength(2);
        expect(result[0].sequence).toMatch(/\\x[0-9a-f]+/);
        expect(result[1].sequence).toMatch(/\\x[0-9a-f]+/);
      });
    });

    describe('Control Characters Outside Ctrl Range', () => {
      it('should handle NUL (0x00)', () => {
        const result = parseKeys(hexBuf(0x00));
        expect(result[0].sequence).toBe('\\x00');
      });

      it('should handle SOH (0x01) - Ctrl+A', () => {
        const result = parseKeys(hexBuf(0x01));
        expect(result[0].name).toBe('a');
        expect(result[0].ctrl).toBe(true);
      });

      it('should handle STX (0x02) - Ctrl+B', () => {
        const result = parseKeys(hexBuf(0x02));
        expect(result[0].name).toBe('b');
        expect(result[0].ctrl).toBe(true);
      });

      it('should handle DEL (0x7f) - Backspace', () => {
        const result = parseKeys(hexBuf(0x7f));
        expect(result[0].name).toBe('backspace');
      });
    });
  });

  describe('Sequence Matching Priority', () => {
    it('should match longer sequences first', () => {
      // Test that F5 (5 bytes) is matched before potential shorter matches
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x35, 0x7e));
      expect(result[0].name).toBe('f5');
    });

    it('should correctly distinguish home formats', () => {
      // VT100 home
      const vt100 = parseKeys(hexBuf(0x1b, 0x5b, 0x48));
      expect(vt100[0].name).toBe('home');

      // Application home
      const app = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x7e));
      expect(app[0].name).toBe('home');
    });
  });
});