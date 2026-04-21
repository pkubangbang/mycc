import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LineEditor } from '../../utils/line-editor.js';
import type { KeyInfo } from '../../utils/key-parser.js';

/**
 * Helper to create a KeyInfo object for testing
 */
function key(
  name: string,
  options: Partial<KeyInfo> = {}
): KeyInfo {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: '',
    ...options,
  };
}

/**
 * Helper to create a printable character KeyInfo
 */
function charKey(c: string, options: Partial<KeyInfo> = {}): KeyInfo {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    sequence: c,
    ...options,
  };
}

/**
 * Create a mock stdout stream for testing
 */
function createMockStdout() {
  return {
    write: vi.fn(),
    columns: 80,
    rows: 24,
    isTTY: true,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as NodeJS.WriteStream;
}

describe('LineEditor - Cursor Movement', () => {
  let mockStdout: NodeJS.WriteStream;
  let onDone: ReturnType<typeof vi.fn>;
  let editor: LineEditor;
  let writeCalls: (string | Uint8Array)[];

  beforeEach(() => {
    mockStdout = createMockStdout();
    onDone = vi.fn();
    writeCalls = [];

    // Capture all write calls
    vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
      writeCalls.push(data);
      return true;
    });

    // Set COLUMNS env for consistent testing
    process.env.COLUMNS = '80';
  });

  afterEach(() => {
    if (editor) {
      editor.close();
    }
    vi.clearAllMocks();
    delete process.env.COLUMNS;
  });

  /**
   * Create a LineEditor with standard options
   */
  function createEditor(options: {
    prompt?: string;
    history?: string[];
    columns?: number;
  } = {}): LineEditor {
    if (options.columns) {
      process.env.COLUMNS = String(options.columns);
    }
    const ed = new LineEditor({
      prompt: options.prompt ?? '> ',
      stdout: mockStdout,
      onDone: onDone as (value: string) => void,
      history: options.history,
    });
    // Clear initial render calls
    writeCalls = [];
    vi.mocked(mockStdout.write).mockClear();
    vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
      writeCalls.push(data);
      return true;
    });
    return ed;
  }

  describe('moveLeft', () => {
    it('should do nothing at start of line', () => {
      editor = createEditor();
      editor.handleKey(key('left'));
      // No crash, cursor stays at start - verify by inserting at start
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should move cursor left one position', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('left'));
      // Cursor should now be between 'a' and 'b'
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aXb');
    });

    it('should move cursor left through multiple characters', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      // Move left twice
      editor.handleKey(key('left'));
      editor.handleKey(key('left'));
      // Insert at new position
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aXbc');
    });

    it('should stop at beginning of content', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      writeCalls = [];
      // Try to move left twice (should only move once effectively)
      editor.handleKey(key('left'));
      editor.handleKey(key('left')); // This should be a no-op
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('Xa');
    });
  });

  describe('moveRight', () => {
    it('should do nothing at end of line', () => {
      editor = createEditor();
      editor.handleKey(key('right'));
      // No crash, cursor stays at end - verify by inserting
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should move cursor right after moving left', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('left')); // Cursor between a and b
      editor.handleKey(key('right')); // Cursor after b
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abX');
    });

    it('should stop at end of content', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      writeCalls = [];
      editor.handleKey(key('right')); // No-op at end
      editor.handleKey(key('right')); // Still no-op
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aX');
    });
  });

  describe('moveHome', () => {
    it('should move cursor to start of content', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('home'));
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('Xabc');
    });

    it('should work with Ctrl+A', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('a', { ctrl: true }));
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('Xab');
    });

    it('should do nothing if already at start', () => {
      editor = createEditor();
      editor.handleKey(key('home'));
      // No crash
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });
  });

  describe('moveEnd', () => {
    it('should move cursor to end of content', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('home')); // Go to start
      editor.handleKey(key('end')); // Go to end
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abcX');
    });

    it('should work with Ctrl+E', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('home'));
      editor.handleKey(key('e', { ctrl: true }));
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abX');
    });

    it('should do nothing if already at end', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      writeCalls = [];
      editor.handleKey(key('end')); // Already at end
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aX');
    });
  });

  // ==========================================
  // Key Edge Cases (related to cursor/key handling)
  // ==========================================

  describe('Key Edge Cases', () => {
    it('should ignore ctrl+meta combinations', () => {
      editor = createEditor();
      editor.handleKey(charKey('a', { ctrl: true, meta: true }));
      editor.handleKey(key('return'));
      // Ctrl+meta with printable should not insert
      expect(onDone).toHaveBeenCalledWith('');
    });

    it('should handle enter key name', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(key('enter'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should handle return key name', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should ignore unknown keys without sequence', () => {
      editor = createEditor();
      editor.handleKey(key('unknown'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('');
    });
  });
});