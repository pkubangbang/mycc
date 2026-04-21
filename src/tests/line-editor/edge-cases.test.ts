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

describe('LineEditor - Edge Cases', () => {
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

  it('should handle empty content', () => {
    editor = createEditor();
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('');
  });

  it('should handle single character', () => {
    editor = createEditor();
    editor.handleKey(charKey('x'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('x');
  });

  it('should handle maximum practical content', () => {
    editor = createEditor();
    const longContent = 'a'.repeat(1000);
    // Insert in chunks to avoid timeout
    for (let i = 0; i < 100; i++) {
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('a'));
    }
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith(longContent);
  });

  it('should handle special characters', () => {
    editor = createEditor();
    editor.handleKey(charKey('!'));
    editor.handleKey(charKey('@'));
    editor.handleKey(charKey('#'));
    editor.handleKey(charKey('$'));
    editor.handleKey(charKey('%'));
    editor.handleKey(charKey('^'));
    editor.handleKey(charKey('&'));
    editor.handleKey(charKey('*'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('!@#$%^&*');
  });

  it('should handle whitespace characters', () => {
    editor = createEditor();
    editor.handleKey(charKey(' '));
    editor.handleKey(charKey('a'));
    editor.handleKey(charKey(' '));
    editor.handleKey(charKey('b'));
    editor.handleKey(charKey(' '));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith(' a b ');
  });

  it('should handle tabs (rendered as character)', () => {
    editor = createEditor();
    editor.handleKey(charKey('\t'));
    editor.handleKey(charKey('a'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('\ta');
  });

  it('should handle rapid key presses', () => {
    editor = createEditor();
    // Simulate rapid typing
    for (let i = 0; i < 100; i++) {
      editor.handleKey(charKey('a'));
    }
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('a'.repeat(100));
  });

  it('should handle complex editing sequence', () => {
    editor = createEditor();
    // Type "hello"
    'hello'.split('').forEach(c => editor.handleKey(charKey(c)));
    // Move to start
    editor.handleKey(key('home'));
    // Delete 'h'
    editor.handleKey(key('delete'));
    // Type 'H'
    editor.handleKey(charKey('H'));
    // Move to end
    editor.handleKey(key('end'));
    // Type '!'
    editor.handleKey(charKey('!'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('Hello!');
  });

  it('should handle Ctrl+L (clear screen)', () => {
    editor = createEditor();
    editor.handleKey(charKey('a'));
    writeCalls = [];
    editor.handleKey(key('l', { ctrl: true }));
    expect(mockStdout.write).toHaveBeenCalled();
    // Content should still exist
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('a');
  });

  it('should handle multiple resize calls (debounce)', async () => {
    editor = createEditor({ columns: 80 });
    // Multiple rapid resizes
    editor.resize(40);
    editor.resize(60);
    editor.resize(80);
    editor.resize(100);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have processed only after debounce
    expect(mockStdout.write).toHaveBeenCalled();
  });

  it('should handle minimum column width', () => {
    editor = createEditor({ columns: 10 }); // Minimum is 20
    editor.handleKey(charKey('a'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('a');
  });
});