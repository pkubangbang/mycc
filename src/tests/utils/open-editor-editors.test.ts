/**
 * open-editor-editors.test.ts - Editor recognition tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Store original env
const originalEditor = process.env.EDITOR;
const originalVisual = process.env.VISUAL;

// Import after mocking
const { getEditor, defaultEditor } = await import('../../utils/open-editor.js');

describe('getEditor', () => {
  it('should recognize vscode by id', () => {
    const editor = getEditor('vscode');
    expect(editor).toEqual({
      id: 'vscode',
      binary: 'code',
      isTerminalEditor: false,
    });
  });

  it('should recognize vscode by binary name', () => {
    const editor = getEditor('code');
    expect(editor).toEqual({
      id: 'vscode',
      binary: 'code',
      isTerminalEditor: false,
    });
  });

  it('should recognize vscode-insiders', () => {
    const editor = getEditor('vscode-insiders');
    expect(editor).toEqual({
      id: 'vscode-insiders',
      binary: 'code-insiders',
      isTerminalEditor: false,
    });
  });

  it('should recognize vscodium', () => {
    const editor = getEditor('vscodium');
    expect(editor).toEqual({
      id: 'vscodium',
      binary: 'codium',
      isTerminalEditor: false,
    });
  });

  it('should recognize vim', () => {
    const editor = getEditor('vim');
    expect(editor).toEqual({
      id: 'vim',
      binary: 'vim',
      isTerminalEditor: true,
    });
  });

  it('should recognize neovim by id', () => {
    const editor = getEditor('neovim');
    expect(editor).toEqual({
      id: 'neovim',
      binary: 'nvim',
      isTerminalEditor: true,
    });
  });

  it('should recognize neovim by binary name', () => {
    const editor = getEditor('nvim');
    expect(editor).toEqual({
      id: 'neovim',
      binary: 'nvim',
      isTerminalEditor: true,
    });
  });

  it('should recognize nano', () => {
    const editor = getEditor('nano');
    expect(editor).toEqual({
      id: 'nano',
      binary: 'nano',
      isTerminalEditor: true,
    });
  });

  it('should recognize sublime', () => {
    const editor = getEditor('sublime');
    expect(editor).toEqual({
      id: 'sublime',
      binary: 'subl',
      isTerminalEditor: false,
    });
  });

  it('should recognize atom', () => {
    const editor = getEditor('atom');
    expect(editor).toEqual({
      id: 'atom',
      binary: 'atom',
      isTerminalEditor: false,
    });
  });

  it('should recognize zed', () => {
    const editor = getEditor('zed');
    expect(editor).toEqual({
      id: 'zed',
      binary: 'zed',
      isTerminalEditor: false,
    });
  });

  it('should recognize webstorm', () => {
    const editor = getEditor('webstorm');
    expect(editor).toEqual({
      id: 'webstorm',
      binary: 'webstorm',
      isTerminalEditor: false,
    });
  });

  it('should recognize intellij by id', () => {
    const editor = getEditor('intellij');
    expect(editor).toEqual({
      id: 'intellij',
      binary: 'idea',
      isTerminalEditor: false,
    });
  });

  it('should recognize intellij by binary name', () => {
    const editor = getEditor('idea');
    expect(editor).toEqual({
      id: 'intellij',
      binary: 'idea',
      isTerminalEditor: false,
    });
  });

  it('should recognize textmate', () => {
    const editor = getEditor('textmate');
    expect(editor).toEqual({
      id: 'textmate',
      binary: 'mate',
      isTerminalEditor: false,
    });
  });

  it('should recognize emacs', () => {
    const editor = getEditor('emacs');
    expect(editor).toEqual({
      id: 'emacs',
      binary: 'emacs',
      isTerminalEditor: true,
    });
  });

  it('should handle unknown editor (e.g., xdg-open)', () => {
    const editor = getEditor('xdg-open');
    expect(editor).toEqual({
      id: 'xdg-open',
      binary: 'xdg-open',
      isTerminalEditor: false,
    });
  });

  it('should preserve case in binary for unknown editors', () => {
    const editor = getEditor('MyCustomEditor');
    expect(editor).toEqual({
      id: 'mycustomeditor',
      binary: 'MyCustomEditor',
      isTerminalEditor: false,
    });
  });

  it('should trim whitespace from editor string', () => {
    const editor = getEditor('  vim  ');
    expect(editor.id).toBe('vim');
  });

  it('should handle editor strings with path', () => {
    const editor = getEditor('/usr/bin/vim');
    expect(editor.id).toBe('/usr/bin/vim');
    expect(editor.binary).toBe('/usr/bin/vim');
  });

  it('should handle uppercase editor names', () => {
    const editor = getEditor('VIM');
    expect(editor.id).toBe('vim');
  });

  it('should handle mixed case editor names', () => {
    const editor = getEditor('VsCode');
    expect(editor.id).toBe('vscode');
  });
});

describe('defaultEditor', () => {
  beforeEach(() => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
  });

  afterEach(() => {
    process.env.EDITOR = originalEditor;
    process.env.VISUAL = originalVisual;
  });

  it('should return editor from EDITOR env', () => {
    process.env.EDITOR = 'vim';
    const editor = defaultEditor();
    expect(editor.id).toBe('vim');
  });

  it('should return editor from VISUAL env when EDITOR not set', () => {
    process.env.VISUAL = 'nano';
    const editor = defaultEditor();
    expect(editor.id).toBe('nano');
  });

  it('should prefer EDITOR over VISUAL', () => {
    process.env.EDITOR = 'vim';
    process.env.VISUAL = 'nano';
    const editor = defaultEditor();
    expect(editor.id).toBe('vim');
  });

  it('should throw error when no EDITOR or VISUAL set', () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    expect(() => defaultEditor()).toThrow('$EDITOR environment variable is not set');
  });

  it('should include helpful message in error', () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    try {
      defaultEditor();
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('~/.mycc-store/.env');
      expect((err as Error).message).toContain('export EDITOR=code');
      expect((err as Error).message).toContain('export EDITOR=vim');
    }
  });
});