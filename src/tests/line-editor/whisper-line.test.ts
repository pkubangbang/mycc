import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
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

describe('LineEditor - Whisper Line', () => {
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
    vi.useRealTimers();
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

  /**
   * Get all write calls concatenated
   */
  function getAllWrites(): string {
    return writeCalls.map(c => typeof c === 'string' ? c : '').join('');
  }

  /**
   * Check if whisper text appears in output
   */
  function outputContainsWhisper(text: string): boolean {
    const output = getAllWrites();
    return output.includes(text);
  }

  describe('setWhisper', () => {
    it('should display whisper line above prompt', () => {
      editor = createEditor();
      editor.setWhisper('Press Ctrl+L again to clear history');

      // Force immediate render (bypass throttling)
      editor.rerender();

      const output = getAllWrites();
      // Whisper line should appear with dim gray color
      expect(output).toContain('\x1b[90mPress Ctrl+L again to clear history\x1b[0m');
    });

    it('should clear whisper text when set to null (whisper line always renders)', () => {
      editor = createEditor();
      editor.setWhisper('Test whisper');
      editor.rerender();

      writeCalls = [];
      vi.mocked(mockStdout.write).mockClear();
      vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
        writeCalls.push(data);
        return true;
      });

      editor.setWhisper(null);

      // Should render without 'Test whisper' text (empty whisper line still present)
      const output = getAllWrites();
      expect(output).not.toContain('\x1b[90mTest whisper\x1b[0m');
      // But the empty whisper line escape code should still be present
      expect(output).toContain('\x1b[90m');
    });

    it('should auto-clear whisper after duration', async () => {
      vi.useFakeTimers();
      editor = createEditor();
      editor.setWhisper('Auto-clear test', 1000);
      editor.rerender();

      // Whisper should be visible
      expect(outputContainsWhisper('Auto-clear test')).toBe(true);
      expect(editor['whisperText']).toBe('Auto-clear test');

      // Clear write calls
      writeCalls = [];
      vi.mocked(mockStdout.write).mockClear();
      vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
        writeCalls.push(data);
        return true;
      });

      // Advance time past duration
      vi.advanceTimersByTime(1001);

      // Whisper should be cleared in state
      expect(editor['whisperText']).toBeNull();
    });

    it('should not auto-clear if duration is undefined', async () => {
      vi.useFakeTimers();
      editor = createEditor();
      editor.setWhisper('No auto-clear');

      // Advance time significantly
      vi.advanceTimersByTime(10000);

      // Whisper should still be there (no timer set)
      expect(editor['whisperTimer']).toBeNull();
      expect(editor['whisperText']).toBe('No auto-clear');
    });

    it('should clear previous timer when setting new whisper', () => {
      vi.useFakeTimers();
      editor = createEditor();
      editor.setWhisper('First whisper', 1000);

      const firstTimer = editor['whisperTimer'];
      expect(firstTimer).not.toBeNull();

      // Set new whisper before first expires
      editor.setWhisper('Second whisper', 1000);

      // First timer should be cleared
      const secondTimer = editor['whisperTimer'];
      expect(secondTimer).not.toBe(firstTimer);
    });

    it('should re-render even when setting null with whisper already null (whisper always present)', () => {
      editor = createEditor();
      // Initially no whisper
      expect(editor['whisperText']).toBeNull();

      writeCalls = [];
      vi.mocked(mockStdout.write).mockClear();
      vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
        writeCalls.push(data);
        return true;
      });

      // Whisper line is always rendered, so setWhisper(null) still renders the empty whisper line
      editor.setWhisper(null);
      expect(writeCalls.length).toBeGreaterThan(0);
    });

    it('should set whisperText when whisper is set', () => {
      editor = createEditor();
      editor.setWhisper('Test whisper');
      expect(editor['whisperText']).toBe('Test whisper');
    });

    it('should clear whisperText when set to null', () => {
      editor = createEditor();
      editor.setWhisper('Test whisper');
      expect(editor['whisperText']).toBe('Test whisper');

      editor.setWhisper(null);
      expect(editor['whisperText']).toBeNull();
    });
  });

  describe('clearScreen', () => {
    it('should clear screen and re-render', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      writeCalls = [];
      vi.mocked(mockStdout.write).mockClear();
      vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
        writeCalls.push(data);
        return true;
      });

      editor.clearScreen();

      // Should send clear screen escape codes (scrollback-preserving)
      const output = getAllWrites();
      expect(output).toContain('\x1b[H\x1b[J');  // Home + clear below
    });

    it('should reset screenStartRow (whisper always present adds 1)', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      // Some content to increase screenStartRow
      editor['screenStartRow'] = 5;
      editor.clearScreen();
      // Whisper line is always rendered (1 row) + cursorLine (0) = 1
      expect(editor['screenStartRow']).toBe(1);
    });

    it('should preserve content after clear', () => {
      editor = createEditor();
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('b'));
      editor.handleKey(charKey('c'));
      editor.clearScreen();
      editor.handleKey(key('return'));
      expect(onDone).toHaveBeenCalledWith('abc');
    });

    it('should preserve whisper line after clear', () => {
      editor = createEditor();
      editor.setWhisper('Test whisper');
      editor.clearScreen();

      // Whisper is always rendered, so whisperText is preserved
      expect(editor['whisperText']).toBe('Test whisper');
    });
  });

  describe('whisper line rendering', () => {
    it('should handle long whisper text', () => {
      editor = createEditor({ columns: 80 });
      const longText = 'This is a very long whisper message that exceeds the terminal width and should still display correctly without crashing';

      // Should not throw
      expect(() => editor.setWhisper(longText)).not.toThrow();
      expect(editor['whisperText']).toBe(longText);
    });

    it('should truncate long whisper text to fit within terminal width (one line)', () => {
      editor = createEditor({ columns: 40 });
      // 80 chars, wider than 40 columns
      const longText = 'This is a very long whisper message that exceeds the terminal width';

      editor.setWhisper(longText);
      editor.rerender();

      const output = getAllWrites();
      // The whisper line is the first line, terminated by \n.
      // Extract the text between the gray escape codes on the first line.
      const firstLine = output.split('\n')[0];
      const match = firstLine.match(/\x1b\[90m(.*?)\x1b\[0m/);
      expect(match).not.toBeNull();
      const rendered = match![1];
      const width = stringWidth(stripAnsi(rendered));

      // Whisper line must be exactly one line: width fits within columns (40).
      expect(width).toBeLessThanOrEqual(40);
      // Truncation should add an ellipsis.
      expect(rendered).toContain('…');
      // The untruncated original must NOT be fully present (it would wrap).
      expect(output).not.toContain(longText);
    });

    it('should not truncate short whisper text', () => {
      editor = createEditor({ columns: 80 });
      editor.setWhisper('short hint');
      editor.rerender();

      const output = getAllWrites();
      const firstLine = output.split('\n')[0];
      const match = firstLine.match(/\x1b\[90m(.*?)\x1b\[0m/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('short hint');
      expect(match![1]).not.toContain('…');
    });

    it('should handle whisper with special characters', () => {
      editor = createEditor();

      // Should not crash on special characters
      expect(() => editor.setWhisper('Special: <>&"\'`$\\')).not.toThrow();
      expect(editor['whisperText']).toBe('Special: <>&"\'`$\\');
    });
  });

  describe('close cleanup', () => {
    it('should clear whisper timer on close', () => {
      vi.useFakeTimers();
      editor = createEditor();
      editor.setWhisper('Test', 5000);
      expect(editor['whisperTimer']).not.toBeNull();

      editor.close();

      // Timer should be cleared
      expect(editor['whisperTimer']).toBeNull();
    });
  });
});