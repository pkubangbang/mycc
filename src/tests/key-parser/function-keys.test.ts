import { describe, it, expect } from 'vitest';
import {
  parseKeys,
  KeyInfo,
} from '../../utils/key-parser';

/**
 * Helper to create a buffer from hex values
 */
function hexBuf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('key-parser', () => {
  describe('Escape Sequences - Function Keys', () => {
    it('should parse F1 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x4f, 0x50));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f1',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1bOP',
      });
    });

    it('should parse F2 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x4f, 0x51));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f2',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1bOQ',
      });
    });

    it('should parse F3 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x4f, 0x52));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f3',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1bOR',
      });
    });

    it('should parse F4 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x4f, 0x53));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f4',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1bOS',
      });
    });

    it('should parse F5 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x35, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f5',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[15~',
      });
    });

    it('should parse F6 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x37, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f6',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[17~',
      });
    });

    it('should parse F7 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x38, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f7',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[18~',
      });
    });

    it('should parse F8 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x39, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f8',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[19~',
      });
    });

    it('should parse F9 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x32, 0x30, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f9',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[20~',
      });
    });

    it('should parse F10 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x32, 0x31, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f10',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[21~',
      });
    });

    it('should parse F11 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x32, 0x33, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f11',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[23~',
      });
    });

    it('should parse F12 key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x32, 0x34, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'f12',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[24~',
      });
    });
  });
});