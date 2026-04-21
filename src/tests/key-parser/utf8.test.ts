import { describe, it, expect } from 'vitest';
import { parseKeys } from '../../utils/key-parser';

/**
 * Helper to create a buffer from hex values
 */
function hexBuf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('key-parser', () => {
  describe('UTF-8 Multi-byte Characters', () => {
    describe('CJK Characters', () => {
      it('should parse Chinese characters (3-byte UTF-8)', () => {
        // '中' in UTF-8 is E4 B8 AD
        const result = parseKeys(hexBuf(0xe4, 0xb8, 0xad));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('中');
        expect(result[0].name).toBe('');
        expect(result[0].ctrl).toBe(false);
        expect(result[0].meta).toBe(false);
      });

      it('should parse Japanese hiragana', () => {
        // 'あ' in UTF-8 is E3 81 82
        const result = parseKeys(hexBuf(0xe3, 0x81, 0x82));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('あ');
      });

      it('should parse Korean hangul', () => {
        // '한' in UTF-8 is ED 95 9C
        const result = parseKeys(hexBuf(0xed, 0x95, 0x9c));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('한');
      });

      it('should parse multiple CJK characters', () => {
        // '你好' in UTF-8
        const result = parseKeys(hexBuf(0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd));
        expect(result).toHaveLength(2);
        expect(result[0].sequence).toBe('你');
        expect(result[1].sequence).toBe('好');
      });
    });

    describe('Emoji', () => {
      it('should parse simple emoji (3-byte UTF-8)', () => {
        // '☺' in UTF-8 is E2 98 BA
        const result = parseKeys(hexBuf(0xe2, 0x98, 0xba));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('☺');
      });

      it('should parse 4-byte emoji', () => {
        // '😀' in UTF-8 is F0 9F 98 80
        const result = parseKeys(hexBuf(0xf0, 0x9f, 0x98, 0x80));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('😀');
      });

      it('should parse another 4-byte emoji', () => {
        // '🎉' in UTF-8 is F0 9F 8E 89
        const result = parseKeys(hexBuf(0xf0, 0x9f, 0x8e, 0x89));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('🎉');
      });

      it('should parse emoji with skin tone modifier (multi-codepoint)', () => {
        // '👋🏻' (waving hand + light skin tone) = F0 9F 91 8B F0 9F 8F BB
        const result = parseKeys(hexBuf(0xf0, 0x9f, 0x91, 0x8b, 0xf0, 0x9f, 0x8f, 0xbb));
        expect(result).toHaveLength(2);
        expect(result[0].sequence).toBe('👋');
        expect(result[1].sequence).toBe('🏻');
      });
    });

    describe('European Characters', () => {
      it('should parse accented characters (2-byte UTF-8)', () => {
        // 'é' in UTF-8 is C3 A9
        const result = parseKeys(hexBuf(0xc3, 0xa9));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('é');
      });

      it('should parse German umlaut', () => {
        // 'ü' in UTF-8 is C3 BC
        const result = parseKeys(hexBuf(0xc3, 0xbc));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('ü');
      });

      it('should parse Spanish ñ', () => {
        // 'ñ' in UTF-8 is C3 B1
        const result = parseKeys(hexBuf(0xc3, 0xb1));
        expect(result).toHaveLength(1);
        expect(result[0].sequence).toBe('ñ');
      });
    });
  });
});