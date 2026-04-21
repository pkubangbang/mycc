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

describe('LineEditor - Line Wrapping', () => {
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

  it('should not wrap content shorter than available width', () => {
    editor = createEditor({ prompt: '> ', columns: 80 });
    // Prompt is 2 chars, so 78 chars available on first line
    for (let i = 0; i < 70; i++) {
      editor.handleKey(charKey('x'));
    }
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('x'.repeat(70));
  });

  it('should wrap content that exceeds first line width', () => {
    editor = createEditor({ prompt: '> ', columns: 20 });
    // Prompt is 2 chars, so 18 chars on first line
    // Add 25 chars to force wrap
    for (let i = 0; i < 25; i++) {
      editor.handleKey(charKey('x'));
    }
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('x'.repeat(25));
  });

  it('should wrap across multiple lines', () => {
    editor = createEditor({ prompt: '> ', columns: 15 });
    // Prompt is 2 chars, so 13 chars on first line, 15 on subsequent
    // Add 50 chars
    for (let i = 0; i < 50; i++) {
      editor.handleKey(charKey('a'));
    }
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('a'.repeat(50));
  });

  it('should handle cursor movement across wrapped lines', () => {
    editor = createEditor({ prompt: '> ', columns: 15 });
    // Add enough chars to wrap
    for (let i = 0; i < 20; i++) {
      editor.handleKey(charKey('a'));
    }
    writeCalls = [];
    // Move to start, insert
    editor.handleKey(key('home'));
    editor.handleKey(charKey('X'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('X' + 'a'.repeat(20));
  });

  it('should recompute wrapping on resize', async () => {
    editor = createEditor({ prompt: '> ', columns: 80 });
    // Add some content
    for (let i = 0; i < 40; i++) {
      editor.handleKey(charKey('x'));
    }
    writeCalls = [];
    // Resize to smaller width
    editor.resize(20);
    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 100));
    // Should have re-rendered
    expect(mockStdout.write).toHaveBeenCalled();
  });

  // ==========================================
  // Prompt Handling Tests (related to wrapping)
  // ==========================================

  describe('Prompt Handling', () => {
    it('should handle different prompt lengths', () => {
      editor = createEditor({ prompt: '>>> ' });
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should handle ANSI-colored prompts', () => {
      editor = createEditor({ prompt: '\x1b[32m> \x1b[0m' }); // Green prompt
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should handle empty prompt', () => {
      editor = createEditor({ prompt: '' });
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });

    it('should handle long prompt', () => {
      editor = createEditor({ prompt: 'very-long-prompt> ' });
      editor.handleKey(charKey('a'));
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('a');
    });
  });
});