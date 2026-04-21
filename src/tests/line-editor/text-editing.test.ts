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
function charKey(c: string): KeyInfo {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    sequence: c,
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

describe('LineEditor - Text Editing', () => {
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

  describe('insertChar', () => {
    it('should insert character at cursor position', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should insert multiple characters in sequence', () => {
      editor = createEditor();
      editor.handleKey(charKey('h'));
      editor.handleKey(charKey('e'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('o'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('hello');
    });

    it('should insert in middle of content', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('left')); // Between a and c
      editor.handleKey(charKey('b'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abc');
    });
  });

  describe('backspace', () => {
    it('should do nothing at start of empty line', () => {
      editor = createEditor();
      editor.handleKey(key('backspace'));
      // No crash, empty content remains
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should delete character before cursor', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('backspace'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should delete from middle of content', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('left')); // Between b and c
      editor.handleKey(key('backspace')); // Delete b
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('ac');
    });

    it('should delete all characters one by one', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('backspace'));
      editor.handleKey(key('backspace'));
      editor.handleKey(charKey('x'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('x');
    });
  });

  describe('delete', () => {
    it('should do nothing at end of line', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      writeCalls = [];
      editor.handleKey(key('delete')); // No-op at end
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should delete character at cursor position', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('home')); // At start
      editor.handleKey(key('right')); // After 'a', before 'b'
      editor.handleKey(key('delete')); // Delete 'b'
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('ac');
    });

    it('should delete first character', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('home'));
      editor.handleKey(key('delete'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('b');
    });

    it('should handle delete on empty content', () => {
      editor = createEditor();
      editor.handleKey(key('delete'));
      // No crash
      editor.handleKey(charKey('x'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('x');
    });
  });

  describe('Ctrl+K (delete to end)', () => {
    it('should delete from cursor to end of line', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('home'));
      editor.handleKey(key('right')); // After 'a'
      editor.handleKey(key('k', { ctrl: true }));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should do nothing at end of line', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      writeCalls = [];
      editor.handleKey(key('k', { ctrl: true }));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });
  });

  describe('Ctrl+U (delete to start)', () => {
    it('should delete from start to cursor', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('left')); // Before 'c'
      editor.handleKey(key('u', { ctrl: true }));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('c');
    });

    it('should do nothing at start of line', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      writeCalls = [];
      editor.handleKey(key('home'));
      editor.handleKey(key('u', { ctrl: true }));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });
  });
});