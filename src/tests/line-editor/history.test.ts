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

describe('LineEditor - History Navigation', () => {
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

  it('should do nothing with empty history', () => {
    editor = createEditor({ history: [] });
    editor.handleKey(key('up'));
    // No crash, empty content
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('');
  });

  it('should navigate to previous history entry', () => {
    editor = createEditor({ history: ['first', 'second', 'third'] });
    writeCalls = [];
    editor.handleKey(key('up'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('third');
  });

  it('should navigate through multiple history entries', () => {
    editor = createEditor({ history: ['first', 'second', 'third'] });
    writeCalls = [];
    editor.handleKey(key('up')); // third
    editor.handleKey(key('up')); // second
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('second');
  });

  it('should stop at oldest history entry', () => {
    editor = createEditor({ history: ['first', 'second'] });
    writeCalls = [];
    editor.handleKey(key('up')); // second
    editor.handleKey(key('up')); // first
    editor.handleKey(key('up')); // still first
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('first');
  });

  it('should navigate down through history', () => {
    editor = createEditor({ history: ['first', 'second', 'third'] });
    writeCalls = [];
    editor.handleKey(key('up')); // third
    editor.handleKey(key('up')); // second
    editor.handleKey(key('down')); // third
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('third');
  });

  it('should restore saved content when navigating back', () => {
    editor = createEditor({ history: ['first'] });
    // Type some content
    editor.handleKey(charKey('n'));
    editor.handleKey(charKey('e'));
    editor.handleKey(charKey('w'));
    writeCalls = [];
    // Navigate up to history
    editor.handleKey(key('up')); // 'first'
    // Navigate back down - should restore 'new'
    editor.handleKey(key('down'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('new');
  });

  it('should clear historyIndex on enter', () => {
    editor = createEditor({ history: ['first'] });
    editor.handleKey(charKey('t'));
    editor.handleKey(charKey('e'));
    editor.handleKey(charKey('s'));
    editor.handleKey(charKey('t'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('test');

    // New editor with history including 'test'
    onDone = vi.fn();
    const history = editor.getHistory();
    editor.close();
    editor = createEditor({ history });
    writeCalls = [];

    // Navigate up, should see 'test' (most recent)
    editor.handleKey(key('up'));
    editor.handleKey(key('return'));
    expect(onDone).toHaveBeenCalledWith('test');
  });

  it('should deduplicate history entries', () => {
    editor = createEditor({ history: [] });
    // Submit same text twice
    editor.handleKey(charKey('a'));
    editor.handleKey(key('return'));

    onDone = vi.fn();
    vi.mocked(mockStdout.write).mockClear();

    editor.handleKey(charKey('a'));
    editor.handleKey(key('return'));

    const history = editor.getHistory();
    // Should only have one 'a' entry
    expect(history.filter(h => h === 'a')).toHaveLength(1);
  });

  it('should not add empty lines to history', () => {
    editor = createEditor({ history: [] });
    editor.handleKey(key('return')); // Empty submit
    expect(editor.getHistory()).toHaveLength(0);
  });
});