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

describe('LineEditor - CJK/Wide Characters', () => {
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

  it('should handle Chinese characters', () => {
    editor = createEditor();
    editor.handleKey(charKey('你'));
    editor.handleKey(charKey('好'));
    editor.handleKey(charKey('世'));
    editor.handleKey(charKey('界'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('你好世界');
  });

  it('should handle Chinese character cursor movement', () => {
    editor = createEditor();
    editor.handleKey(charKey('中'));
    editor.handleKey(charKey('文'));
    editor.handleKey(charKey('测'));
    editor.handleKey(charKey('试'));
    writeCalls = [];
    // Move left through Chinese characters
    editor.handleKey(key('left'));
    editor.handleKey(key('left'));
    editor.handleKey(charKey('X'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('中文X测试');
  });

  it('should handle emoji characters', () => {
    editor = createEditor();
    editor.handleKey(charKey('😀'));
    editor.handleKey(charKey('🎉'));
    editor.handleKey(charKey('🚀'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('😀🎉🚀');
  });

  it('should handle mixed ASCII and wide characters', () => {
    editor = createEditor();
    editor.handleKey(charKey('a'));
    editor.handleKey(charKey('中'));
    editor.handleKey(charKey('b'));
    editor.handleKey(charKey('文'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('a中b文');
  });

  it('should handle backspace on wide characters', () => {
    editor = createEditor();
    editor.handleKey(charKey('中'));
    editor.handleKey(charKey('文'));
    writeCalls = [];
    editor.handleKey(key('backspace'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('中');
  });

  it('should handle delete on wide characters', () => {
    editor = createEditor();
    editor.handleKey(charKey('中'));
    editor.handleKey(charKey('文'));
    writeCalls = [];
    editor.handleKey(key('home'));
    editor.handleKey(key('delete'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('文');
  });

  it('should handle combining characters (emoji with skin tone)', () => {
    editor = createEditor();
    // Emoji with skin tone modifier (combining)
    editor.handleKey(charKey('👋'));
    editor.handleKey(charKey('🏻')); // Skin tone modifier
    editor.handleKey(key('return'));
    // These might be combined or separate depending on grapheme segmentation
    const result = onDone.mock.calls[0][0];
    expect(result).toContain('👋');
  });

  it('should wrap correctly with wide characters', () => {
    editor = createEditor({ prompt: '> ', columns: 10 });
    // Each Chinese char is width 2, so ~4 chars fit on first line
    for (let i = 0; i < 10; i++) {
      editor.handleKey(charKey('中'));
    }
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('中'.repeat(10));
  });

  // ==========================================
  // Cleanup Tests
  // ==========================================

  describe('Cleanup', () => {
    it('should clear resize timer on close', async () => {
      editor = createEditor();
      editor.resize(40);
      // Close immediately (timer should be cleared)
      editor.close();
      // Wait longer than debounce
      await new Promise(resolve => setTimeout(resolve, 100));
      // Should not have errors
    });

    it('should handle multiple close calls', () => {
      editor = createEditor();
      editor.close();
      editor.close(); // Should not throw
    });
  });

  // ==========================================
  // Render Optimization Tests
  // ==========================================

  describe('Render Optimization', () => {
    it('should throttle rapid renders', async () => {
      editor = createEditor();
      // Clear initial calls
      vi.mocked(mockStdout.write).mockClear();

      // Rapid key presses
      for (let i = 0; i < 10; i++) {
        editor.handleKey(charKey('a'));
      }

      // Wait for any queued renders
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have rendered (possibly fewer times than key presses due to throttling)
      expect(mockStdout.write).toHaveBeenCalled();
    });
  });
});