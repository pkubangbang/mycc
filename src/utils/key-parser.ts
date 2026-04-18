/**
 * key-parser.ts - Parse raw stdin bytes into structured key info
 *
 * Converts raw terminal input into KeyInfo objects for IPC forwarding.
 * Handles escape sequences for special keys like arrows, function keys, etc.
 *
 * Uses hex comparison for control characters and only converts to UTF-8
 * for readable printable characters.
 */

export interface KeyInfo {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
}

// Common escape sequences and their key names (hex prefixes for matching)
const ESCAPE_SEQUENCES_HEX: Record<string, string> = {
  '1b5b41': 'up',
  '1b5b42': 'down',
  '1b5b43': 'right',
  '1b5b44': 'left',
  '1b5b48': 'home',
  '1b5b46': 'end',
  '1b5b317e': 'home',
  '1b5b347e': 'end',
  '1b5b327e': 'insert',
  '1b5b337e': 'delete',
  '1b5b357e': 'pageup',
  '1b5b367e': 'pagedown',
  '1b4f50': 'f1',
  '1b4f51': 'f2',
  '1b4f52': 'f3',
  '1b4f53': 'f4',
  '1b5b31357e': 'f5',
  '1b5b31377e': 'f6',
  '1b5b31387e': 'f7',
  '1b5b31397e': 'f8',
  '1b5b32307e': 'f9',
  '1b5b32317e': 'f10',
  '1b5b32337e': 'f11',
  '1b5b32347e': 'f12',
};

// Ctrl key mappings (Ctrl+A = 1, Ctrl+B = 2, etc.)
const CTRL_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const CTRL_CHAR_NAMES: Record<number, string> = {};
for (let i = 0; i < 26; i++) {
  CTRL_CHAR_NAMES[i + 1] = CTRL_CHARS[i];
}

/**
 * Parse all keys from a Buffer (handles multi-byte buffers)
 * Returns an array of KeyInfo, one for each key pressed
 */
export function parseKeys(data: Buffer): KeyInfo[] {
  const results: KeyInfo[] = [];
  let offset = 0;

  while (offset < data.length) {
    const { keyInfo, consumed } = parseNextKey(data, offset);
    if (keyInfo) {
      results.push(keyInfo);
    }
    offset += consumed;
  }

  return results;
}

/**
 * Parse the next key from a buffer starting at offset
 * Returns the KeyInfo and number of bytes consumed
 */
function parseNextKey(data: Buffer, offset: number): { keyInfo: KeyInfo; consumed: number } {
  const remaining = data.length - offset;
  const hex = data.toString('hex', offset);

  // Check for escape sequences (start with 0x1b)
  if (data[offset] === 0x1b) {
    // Try to match known escape sequences (longest first)
    const sortedSeqs = Object.entries(ESCAPE_SEQUENCES_HEX).sort((a, b) => b[0].length - a[0].length);
    for (const [seqHex, name] of sortedSeqs) {
      if (hex.startsWith(seqHex)) {
        const consumed = seqHex.length / 2; // hex string length / 2 = byte length
        return {
          keyInfo: {
            name,
            ctrl: false,
            meta: true,
            shift: false,
            sequence: data.toString('utf8', offset, offset + consumed),
          },
          consumed,
        };
      }
    }

    // ESC key alone
    if (remaining === 1 || (remaining >= 2 && data[offset + 1] !== 0x5b && data[offset + 1] !== 0x4f)) {
      return {
        keyInfo: { name: 'escape', ctrl: false, meta: false, shift: false, sequence: '\x1b' },
        consumed: 1,
      };
    }

    // Unknown escape sequence - consume just the ESC
    return {
      keyInfo: { name: 'escape', ctrl: false, meta: false, shift: false, sequence: '\x1b' },
      consumed: 1,
    };
  }

  // Single byte key
  const code = data[offset];

  // Enter/Return (must check before Ctrl chars, since 0x0d = 13 = Ctrl+M)
  if (code === 0x0d || code === 0x0a) {
    return {
      keyInfo: { name: 'return', ctrl: false, meta: false, shift: false, sequence: '\r' },
      consumed: 1,
    };
  }

  // Backspace (must check before Ctrl chars, since 0x08 = 8 = Ctrl+H)
  if (code === 0x7f || code === 0x08) {
    return {
      keyInfo: { name: 'backspace', ctrl: false, meta: false, shift: false, sequence: '\x7f' },
      consumed: 1,
    };
  }

  // Ctrl characters (0x01 - 0x1A), excluding Enter and Backspace codes
  if (code >= 1 && code <= 26) {
    return {
      keyInfo: {
        name: CTRL_CHAR_NAMES[code] || '',
        ctrl: true,
        meta: false,
        shift: false,
        sequence: String.fromCharCode(code + 96), // Ctrl+A -> 'a'
      },
      consumed: 1,
    };
  }

  // Printable ASCII character (0x20 - 0x7e)
  if (code >= 0x20 && code <= 0x7e) {
    const char = String.fromCharCode(code);
    const isUpper = char >= 'A' && char <= 'Z';
    const isLower = char >= 'a' && char <= 'z';
    return {
      keyInfo: {
        name: isLower ? char : (isUpper ? char.toLowerCase() : ''),
        ctrl: false,
        meta: false,
        shift: isUpper,
        sequence: char,
      },
      consumed: 1,
    };
  }

  // Multi-byte UTF-8 character (try to decode)
  // UTF-8 continuation bytes are 0x80-0xBF, leading bytes are 0xC0-0xFF
  if (code >= 0x80) {
    // Try to decode as UTF-8
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      // Find the end of the UTF-8 sequence
      let end = offset + 1;
      while (end < data.length && (data[end] & 0xc0) === 0x80) {
        end++;
      }
      const str = decoder.decode(data.subarray(offset, end));
      return {
        keyInfo: { name: '', ctrl: false, meta: false, shift: false, sequence: str },
        consumed: end - offset,
      };
    } catch {
      // Invalid UTF-8, consume single byte
      const hexByte = code.toString(16).padStart(2, '0');
      return {
        keyInfo: { name: '', ctrl: false, meta: false, shift: false, sequence: '\\x' + hexByte },
        consumed: 1,
      };
    }
  }

  // Unknown byte
  const hexByte = code.toString(16).padStart(2, '0');
  return {
    keyInfo: { name: '', ctrl: false, meta: false, shift: false, sequence: '\\x' + hexByte },
    consumed: 1,
  };
}

/**
 * Parse a single key from a Buffer (for backward compatibility)
 * @deprecated Use parseKeys instead for multi-byte support
 */
export function parseKey(data: Buffer): KeyInfo {
  const keys = parseKeys(data);
  return keys[0] || { name: '', ctrl: false, meta: false, shift: false, sequence: '' };
}

/**
 * Check if data represents Ctrl+C
 */
export function isCtrlC(data: Buffer): boolean {
  return data.length === 1 && data[0] === 3;
}

/**
 * Check if data represents Ctrl+D
 */
export function isCtrlD(data: Buffer): boolean {
  return data.length === 1 && data[0] === 4;
}

/**
 * Check if data represents ESC key
 */
export function isEscape(data: Buffer): boolean {
  return data.length === 1 && data[0] === 0x1b;
}

/**
 * Check if data represents Ctrl+Enter (Ctrl+J = 0x0a)
 * In terminals, Ctrl+Enter typically sends the same as Ctrl+J (line feed)
 */
export function isCtrlEnter(data: Buffer): boolean {
  return data.length === 1 && data[0] === 0x0a;
}