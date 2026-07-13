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

    it('should extend selection with multiple Shift+Left', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('left', { shift: true })); // select 'bc'
      // selection = [1,3) -> anchor 3, cursor 1
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aX');
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

    it('should not render inverse video for empty selection (anchor == cursor)', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      // content: a b c CURSOR (cursor at 3)
      editor.handleKey(key('left', { shift: true })); // select 'c', cursor at 2
      editor.handleKey(key('right', { shift: true })); // cursor back to 3, empty selection
      writeCalls = [];
      editor.handleKey(key('left', { shift: true })); // re-select 'c' to force a render
      // Now go back to empty by shifting right
      editor.handleKey(key('right', { shift: true }));
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

    it('should delete selection on Delete', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('home'));
      editor.handleKey(key('right', { shift: true })); // select 'a'
      editor.handleKey(key('delete'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('bc');
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

    it('should replace multi-char selection when typing', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(charKey('d'));
      editor.handleKey(key('left', { shift: true })); // select 'd'
      editor.handleKey(key('left', { shift: true })); // select 'cd'
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abX');
    });

    it('should place cursor at deletion point after delete-selection', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('backspace')); // delete 'c', cursor at index 2
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

  describe('Selection clearing', () => {
    it('should clear selection on non-shift Left', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('left')); // plain left -> clears selection
      // Now typing should insert, not replace
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      // cursor was at 2 (after shift+left), plain left -> cursor at 1
      // insert X at 1 -> 'aXbc'
      expect(onDone).toHaveBeenCalledWith('aXbc');
    });

    it('should clear selection on non-shift Right', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c', cursor at 2
      editor.handleKey(key('right')); // plain right -> clears, cursor at 3
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abcX');
    });

    it('should clear selection on Home', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('home')); // clears selection, cursor at 0
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('Xabc');
    });

    it('should clear selection on End', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('home'));
      editor.handleKey(key('right', { shift: true })); // select 'a'
      editor.handleKey(key('end')); // clears selection, cursor at end
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abcX');
    });

    it('should clear selection on Enter (submit)', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('return'));
      // Selection deleted, then submitted with remaining content 'ab'
      expect(onDone).toHaveBeenCalledWith('ab');
    });

    it('should clear selection on Ctrl+U', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.handleKey(key('u', { ctrl: true })); // Ctrl+U deletes selection first
      editor.handleKey(key('return'));
      // Selection 'c' deleted by ctrl+u's deleteSelection, then ctrl+u
      // kills from cursor to start -> empty
      expect(onDone).toHaveBeenCalledWith('');
    });

    it('should clear selection on Ctrl+K', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('home'));
      editor.handleKey(key('right', { shift: true })); // select 'a', cursor at 1
      editor.handleKey(key('k', { ctrl: true })); // Ctrl+K deletes selection, then kills to end
      editor.handleKey(key('return'));
      // Selection 'a' deleted, then ctrl+k kills from cursor(0) to end -> empty
      expect(onDone).toHaveBeenCalledWith('');
    });

    it('should clear selection on history Up', () => {
      editor = createEditor({ history: ['past'] });
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(key('left', { shift: true })); // select 'b'
      editor.handleKey(key('up')); // history up -> setContent('past'), clears selection
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('past');
    });
  });

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

    it('should render Shift+Home selection with inverse video', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      writeCalls = [];
      editor.handleKey(key('home', { shift: true }));
      editor.rerender();
      const output = lastRender();
      expect(output).toContain('\x1b[7ma\x1b[0m');
      expect(output).toContain('\x1b[7mb\x1b[0m');
      expect(output).toContain('\x1b[7mc\x1b[0m');
    });
  });

  // ==========================================
  // Paste (insertAtCursor) replaces selection
  // ==========================================

  describe('Paste replaces selection', () => {
    it('should delete selection before pasting', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.handleKey(key('left', { shift: true })); // select 'c'
      editor.insertAtCursor('XYZ');
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abXYZ');
    });
  });

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

    it('should move cursor right on Ctrl+Right', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(key('home')); // cursor at 0
      editor.handleKey(key('right', { ctrl: true })); // plain right
      editor.handleKey(charKey('X'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('aXb');
    });
  });
});