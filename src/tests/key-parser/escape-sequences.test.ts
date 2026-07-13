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
  describe('parseKeys', () => {
    it('should return empty array for empty buffer', () => {
      expect(parseKeys(Buffer.from([]))).toEqual([]);
    });

    it('should parse a single key', () => {
      const result = parseKeys(Buffer.from([0x61])); // 'a'
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('a');
    });

    it('should parse multiple keys in sequence', () => {
      const result = parseKeys(Buffer.from([0x61, 0x62, 0x63])); // 'a', 'b', 'c'
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('a');
      expect(result[1].name).toBe('b');
      expect(result[2].name).toBe('c');
    });
  });

  describe('parseKey (deprecated)', () => {
    it('should return first key from buffer', () => {
      const result = parseKeys(Buffer.from([0x61])); // 'a'
      expect(result[0].name).toBe('a');
    });

    it('should return empty KeyInfo for empty buffer', () => {
      const result = parseKeys(Buffer.from([]));
      expect(result).toEqual([]);
    });
  });

  describe('Escape Sequences - Arrow Keys', () => {
    it('should parse up arrow key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x41));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'up',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[A',
      });
    });

    it('should parse down arrow key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x42));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'down',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[B',
      });
    });

    it('should parse right arrow key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x43));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'right',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[C',
      });
    });

    it('should parse left arrow key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x44));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'left',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[D',
      });
    });
  });

  describe('Escape Sequences - Home and End', () => {
    it('should parse home key (VT100 format)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x48));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'home',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[H',
      });
    });

    it('should parse end key (VT100 format)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x46));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'end',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[F',
      });
    });

    it('should parse home key (application format)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'home',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[1~',
      });
    });

    it('should parse end key (application format)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x34, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'end',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[4~',
      });
    });
  });

  describe('Escape Sequences - Navigation Keys', () => {
    it('should parse insert key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x32, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'insert',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[2~',
      });
    });

    it('should parse delete key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x33, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'delete',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[3~',
      });
    });

    it('should parse page up key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x35, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'pageup',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[5~',
      });
    });

    it('should parse page down key', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x36, 0x7e));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<KeyInfo>({
        name: 'pagedown',
        ctrl: false,
        meta: true,
        shift: false,
        sequence: '\x1b[6~',
      });
    });
  });

  describe('Escape Sequences - Modifier-Extended (Shift/Ctrl+Arrow)', () => {
    it('should parse Shift+Left (ESC[1;2D)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('left');
      expect(result[0].shift).toBe(true);
      expect(result[0].ctrl).toBe(false);
      expect(result[0].meta).toBe(true);
      expect(result[0].sequence).toBe('\x1b[1;2D');
    });

    it('should parse Shift+Right (ESC[1;2C)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x43));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('right');
      expect(result[0].shift).toBe(true);
      expect(result[0].ctrl).toBe(false);
    });

    it('should parse Shift+Up (ESC[1;2A)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('up');
      expect(result[0].shift).toBe(true);
    });

    it('should parse Shift+Down (ESC[1;2B)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x42));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('down');
      expect(result[0].shift).toBe(true);
    });

    it('should parse Ctrl+Left (ESC[1;5D)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('left');
      expect(result[0].ctrl).toBe(true);
      expect(result[0].shift).toBe(false);
    });

    it('should parse Ctrl+Right (ESC[1;5C)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x43));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('right');
      expect(result[0].ctrl).toBe(true);
    });

    it('should parse Shift+Ctrl+Left (ESC[1;6D)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x44));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('left');
      expect(result[0].shift).toBe(true);
      expect(result[0].ctrl).toBe(true);
    });

    it('should parse Shift+Ctrl+Right (ESC[1;6C)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x43));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('right');
      expect(result[0].shift).toBe(true);
      expect(result[0].ctrl).toBe(true);
    });

    it('should parse Shift+Home (ESC[1;2H)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x48));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('home');
      expect(result[0].shift).toBe(true);
    });

    it('should parse Shift+End (ESC[1;2F)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x46));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('end');
      expect(result[0].shift).toBe(true);
    });

    it('should not produce garbled chars for Shift+Left (single key, not 6)', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44));
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('left');
    });

    it('should parse Shift+Left followed by a printable char', () => {
      const result = parseKeys(hexBuf(0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44, 0x61));
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('left');
      expect(result[0].shift).toBe(true);
      expect(result[1].name).toBe('a');
    });
  });
});