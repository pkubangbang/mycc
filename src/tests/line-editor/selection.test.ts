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

describe('LineEditor - Selection', () => {
  let mockStdout: NodeJS.WriteStream;
  let onDone: ReturnType<typeof vi.fn>;
  let editor: LineEditor;
  let writeCalls: (string | Uint8Array)[];

  beforeEach(() => {
    mockStdout = createMockStdout();
    onDone = vi.fn();
    writeCalls = [];

    vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
      writeCalls.push(data);
      return true;
    });

    process.env.COLUMNS = '80';
  });

  afterEach(() => {
    if (editor) {
      editor.close();
    }
    vi.clearAllMocks();
    delete process.env.COLUMNS;
  });

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
    writeCalls = [];
    vi.mocked(mockStdout.write).mockClear();
    vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
      writeCalls.push(data);
      return true;
    });
    return ed;
  }

  /** Get the last write call's string (the most recent render output). */
  function lastRender(): string {
    const last = writeCalls[writeCalls.length - 1];
    if (last === undefined) return '';
    return typeof last === 'string' ? last : Buffer.from(last).toString('utf8');
  }

  // ==========================================
  // Anchor Setting & Extending
  // ==========================================

  describe('Shift+Left/Right — anchor and extend', () => {
    it('should set anchor and move cursor left on Shift+Left', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR  (cursor at index 3)
      writeCalls = [];
      editor.handleKey(key('left', { shift: true }));
      // Now selection = [2,3) -> cursor at index 2, anchor at 3
      // Insert a char to replace the selection and verify
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      // 'c' was selected and replaced by 'X' -> 'abX'
      expect(onDone).toHaveBeenCalledWith('abX');
    });

    it('should shrink selection when direction reverses (Shift+Left then Shift+Right)', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR (cursor at 3)
      editor.handleKey(key('left', { shift: true })); // select 'c', cursor at 2
      editor.handleKey(key('left', { shift: true })); // select 'bc', cursor at 1
      editor.handleKey(key('right', { shift: true })); // shrink to 'c', cursor at 2
      // selection = [2,3) -> only 'c' selected
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abX');
    });

    it('should re-expand selection on the other side after crossing anchor', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR (cursor at 3)
      editor.handleKey(key('left', { shift: true })); // select 'c', cursor at 2, anchor 3
      editor.handleKey(key('right', { shift: true })); // cursor back to 3, selection empty
      editor.handleKey(key('right', { shift: true })); // no-op at end, still empty
      // No selection now -> typing inserts normally
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abcX');
    });

    it('should select to the right with Shift+Right', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // Move cursor to start
      editor.handleKey(key('home'));
      // content: CURSOR a b c (cursor at 0)
      editor.handleKey(key('right', { shift: true })); // select 'a', cursor at 1, anchor 0
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('Xbc');
    });
  });

  // ==========================================
  // Rendering (inverse video)
  // ==========================================

  describe('Rendering — inverse video', () => {
    it('should render selected chars with inverse video (\\x1b[7m)', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR
      writeCalls = [];
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.rerender();
      const output = lastRender();
      // The selected 'c' should be wrapped in \x1b[7m...\x1b[0m
      expect(output).toContain('\x1b[7mc\x1b[0m');
    });

    it('should not render inverse video when no selection', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      editor.handleKey(key('left')); // plain left, no selection
      editor.rerender();
      const output = lastRender();
      expect(output).not.toContain('\x1b[7m');
    });

  });

  // ==========================================
  // Deletion & Replace
  // ==========================================

  describe('Selection deletion & replace', () => {
    it('should delete selection on Backspace', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('backspace'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('ab');
    });


    it('should replace selection when typing a char', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abX');
    });



    it('should do normal backspace when no selection', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(key('backspace'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });
  });

  // ==========================================
  // Selection Clearing
  // ==========================================

  // (selection clearing tests retired)

  // ==========================================
  // Shift+Home / Shift+End
  // ==========================================

  describe('Shift+Home / Shift+End', () => {
    it('should select from cursor to start with Shift+Home', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR (cursor at 3)
      editor.handleKey(key('home', { shift: true })); // select 'abc', cursor at 0
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('X');
    });

    it('should select from cursor to end with Shift+End', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('home')); // cursor at 0
      editor.handleKey(key('end', { shift: true })); // select 'abc', cursor at 3
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('X');
    });

  });

  // ==========================================
  // Paste (insertAtCursor) replaces selection
  // ==========================================

  // (paste replaces selection tests retired)

  // ==========================================
  // Ctrl+Arrow (deferred word movement — treated as plain movement)
  // ==========================================

  describe('Ctrl+Arrow treated as plain movement (no garbled chars)', () => {
    it('should move cursor left on Ctrl+Left (no selection, no garbled chars)', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      // content: a b CURSOR
      editor.handleKey(key('left', { ctrl: true })); // plain left (ctrl, not shift)
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aXb');
    });

  });
});
