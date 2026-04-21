import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('LineEditor - Bang Command', () => {
  let mockStdout: NodeJS.WriteStream;
  let editor: LineEditor;
  let onDone: ReturnType<typeof vi.fn>;
  let writeCalls: (string | Uint8Array)[];

  beforeEach(() => {
    mockStdout = createMockStdout();
    onDone = vi.fn();
    writeCalls = [];
    vi.mocked(mockStdout.write).mockImplementation((data: string | Uint8Array) => {
      writeCalls.push(data);
      return true;
    });
  });

  function createEditor(options: { prompt?: string } = {}) {
    return new LineEditor({
      prompt: options.prompt ?? '> ',
      stdout: mockStdout,
      onDone: onDone as (value: string) => void,
    });
  }

  describe('Bang command (!) handling', () => {
    it('should preserve ! prefix when returning content', () => {
      editor = createEditor({ prompt: '> ' });

      // Type '!date'
      editor.handleKey(charKey('!'));
      editor.handleKey(charKey('d'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('t'));
      editor.handleKey(charKey('e'));
      editor.handleKey(key('return'));

      // Should return '!date', not 'date'
      expect(onDone).toHaveBeenCalledWith('!date');
    });

    it('should NOT add ! prefix when not in bang mode', () => {
      editor = createEditor({ prompt: '> ' });

      // Type 'date' without !
      editor.handleKey(charKey('d'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey('t'));
      editor.handleKey(charKey('e'));
      editor.handleKey(key('return'));

      // Should return 'date' without adding !
      expect(onDone).toHaveBeenCalledWith('date');
    });

    it('should handle ! followed by backspace then new content (prompt switches back)', () => {
      // After typing !, the prompt changes to bang mode.
      // Backspace removes !, content becomes empty, prompt switches back.
      // Subsequent typing returns content without ! prefix.
      editor = createEditor({ prompt: '> ' });

      // Type '!' then backspace (content becomes empty), then type 'ls'
      editor.handleKey(charKey('!'));
      editor.handleKey(key('backspace'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('s'));
      editor.handleKey(key('return'));

      // Prompt switched back, so 'ls' is returned without ! prefix
      expect(onDone).toHaveBeenCalledWith('ls');
    });

    it('should handle empty bang command (just !)', () => {
      editor = createEditor({ prompt: '> ' });

      // Type just '!' and press enter
      editor.handleKey(charKey('!'));
      editor.handleKey(key('return'));

      // Should return '!' (just the bang)
      expect(onDone).toHaveBeenCalledWith('!');
    });

    it('should handle ! not at the start of input', () => {
      editor = createEditor({ prompt: '> ' });

      // Type 'echo!' - ! is not at start
      editor.handleKey(charKey('e'));
      editor.handleKey(charKey('c'));
      editor.handleKey(charKey('h'));
      editor.handleKey(charKey('o'));
      editor.handleKey(charKey('!'));
      editor.handleKey(key('return'));

      // Should return 'echo!' as-is (no bang command transformation)
      expect(onDone).toHaveBeenCalledWith('echo!');
    });

    it('should handle multiple ! characters (both preserved)', () => {
      // When typing '!!', both ! characters are preserved
      editor = createEditor({ prompt: '> ' });

      // Type '!!' - double bang
      editor.handleKey(charKey('!'));
      editor.handleKey(charKey('!'));
      editor.handleKey(key('return'));

      // Both '!' characters are preserved: '!!'
      expect(onDone).toHaveBeenCalledWith('!!');
    });

    it('should handle ! with spaces in command', () => {
      editor = createEditor({ prompt: '> ' });

      // Type '!ls -la /home'
      editor.handleKey(charKey('!'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('s'));
      editor.handleKey(charKey(' '));
      editor.handleKey(charKey('-'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('a'));
      editor.handleKey(charKey(' '));
      editor.handleKey(charKey('/'));
      editor.handleKey(charKey('h'));
      editor.handleKey(charKey('o'));
      editor.handleKey(charKey('m'));
      editor.handleKey(charKey('e'));
      editor.handleKey(key('return'));

      // Should preserve entire command with ! prefix
      expect(onDone).toHaveBeenCalledWith('!ls -la /home');
    });

    it('should handle ! with special characters', () => {
      editor = createEditor({ prompt: '> ' });

      // Type '!echo "hello $USER"'
      editor.handleKey(charKey('!'));
      editor.handleKey(charKey('e'));
      editor.handleKey(charKey('c'));
      editor.handleKey(charKey('h'));
      editor.handleKey(charKey('o'));
      editor.handleKey(charKey(' '));
      editor.handleKey(charKey('"'));
      editor.handleKey(charKey('h'));
      editor.handleKey(charKey('e'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('l'));
      editor.handleKey(charKey('o'));
      editor.handleKey(charKey(' '));
      editor.handleKey(charKey('$'));
      editor.handleKey(charKey('U'));
      editor.handleKey(charKey('S'));
      editor.handleKey(charKey('E'));
      editor.handleKey(charKey('R'));
      editor.handleKey(charKey('"'));
      editor.handleKey(key('return'));

      // Should preserve special characters
      expect(onDone).toHaveBeenCalledWith('!echo "hello $USER"');
    });

    it('should handle backspacing all content after ! (returns single !)', () => {
      // After typing !test and backspacing 'test', only ! remains
      editor = createEditor({ prompt: '> ' });

      // Type '!test' then backspace 'test' (4 chars)
      editor.handleKey(charKey('!'));
      editor.handleKey(charKey('t'));
      editor.handleKey(charKey('e'));
      editor.handleKey(charKey('s'));
      editor.handleKey(charKey('t'));
      editor.handleKey(key('backspace')); // remove 't'
      editor.handleKey(key('backspace')); // remove 's'
      editor.handleKey(key('backspace')); // remove 'e'
      editor.handleKey(key('backspace')); // remove 't'
      editor.handleKey(key('return'));

      // Content is just '!'
      expect(onDone).toHaveBeenCalledWith('!');
    });

    it('should handle ! with pipes and redirects', () => {
      editor = createEditor({ prompt: '> ' });

      // Type '!cat file.txt | grep pattern > output.txt'
      const command = '!cat file.txt | grep pattern > output.txt';
      for (const c of command) {
        editor.handleKey(charKey(c));
      }
      editor.handleKey(key('return'));

      // Should preserve entire command including pipes and redirects
      expect(onDone).toHaveBeenCalledWith('!cat file.txt | grep pattern > output.txt');
    });
  });
});