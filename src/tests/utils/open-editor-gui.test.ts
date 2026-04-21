/**
 * open-editor-gui.test.ts - GUI editor tests
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
const { openEditor } = await import('../../utils/open-editor.js');

describe('openEditor - GUI editors', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReset();
    delete process.env.EDITOR;
    delete process.env.VISUAL;
  });

  afterEach(() => {
    process.env.EDITOR = originalEditor;
    process.env.VISUAL = originalVisual;
    vi.clearAllMocks();
  });

  describe('VS Code', () => {
    it('should spawn with --goto for line numbers', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10:5'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['--goto', 'file.ts:10:5'],
        expect.objectContaining({ detached: true })
      );
      expect(mockProcess.unref).toHaveBeenCalled();
    });

    it('should spawn with --goto for line only (no column)', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['--goto', 'file.ts:10'],
        expect.objectContaining({ detached: true })
      );
    });

    it('should spawn without --goto when no line number', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['file.ts'],
        expect.objectContaining({ detached: true })
      );
    });
  });

  describe('Sublime', () => {
    it('should support --goto', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:42:10'], { editor: 'sublime' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'subl',
        ['--goto', 'file.ts:42:10'],
        expect.any(Object)
      );
    });
  });

  describe('Zed', () => {
    it('should support --goto', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:5'], { editor: 'zed' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'zed',
        ['--goto', 'file.ts:5'],
        expect.any(Object)
      );
    });
  });

  describe('Atom', () => {
    it('should support --goto', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:20:5'], { editor: 'atom' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'atom',
        ['--goto', 'file.ts:20:5'],
        expect.any(Object)
      );
    });
  });

  describe('VSCodium', () => {
    it('should support --goto', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10'], { editor: 'vscodium' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'codium',
        ['--goto', 'file.ts:10'],
        expect.any(Object)
      );
    });
  });

  describe('VS Code Insiders', () => {
    it('should support --goto', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10:5'], { editor: 'vscode-insiders' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code-insiders',
        ['--goto', 'file.ts:10:5'],
        expect.any(Object)
      );
    });
  });

  describe('Common GUI behavior', () => {
    it('should use stdio: ignore for GUI editors', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        expect.any(Array),
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('should use detached: true for GUI editors', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'atom' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'atom',
        expect.any(Array),
        expect.objectContaining({ detached: true })
      );
      expect(mockProcess.unref).toHaveBeenCalled();
    });

    it('should handle multiple files', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file1.ts:10', 'file2.ts:20:5'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['--goto', 'file1.ts:10', '--goto', 'file2.ts:20:5'],
        expect.objectContaining({ detached: true })
      );
    });

    it('should handle empty file array', async () => {
      const mockProcess = { unref: vi.fn() };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor([], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith('code', [], expect.any(Object));
    });
  });
});

describe('openEditor - unknown editors (GUI)', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReset();
  });

  it('should spawn unknown editor with file', async () => {
    const mockProcess = { unref: vi.fn() };
    mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts'], { editor: 'xdg-open' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'xdg-open',
      ['file.ts'],
      expect.objectContaining({ detached: true })
    );
  });

  it('should treat unknown editors as non-terminal (GUI)', async () => {
    const mockProcess = { unref: vi.fn() };
    mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts'], { editor: 'some-gui-editor' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'some-gui-editor',
      ['file.ts'],
      expect.objectContaining({ stdio: 'ignore', detached: true })
    );
  });

  it('should not use --goto for unknown editors (line/column stripped)', async () => {
    const mockProcess = { unref: vi.fn() };
    mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts:10:5'], { editor: 'xdg-open' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'xdg-open',
      ['file.ts'],
      expect.any(Object)
    );
  });
});

describe('openEditor - default editor', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReset();
    delete process.env.EDITOR;
    delete process.env.VISUAL;
  });

  afterEach(() => {
    process.env.EDITOR = originalEditor;
    process.env.VISUAL = originalVisual;
  });

  it('should use EDITOR env variable when no editor option provided', async () => {
    process.env.EDITOR = 'code';
    const mockProcess = { unref: vi.fn() };
    mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts']);

    expect(mockSpawn).toHaveBeenCalledWith('code', expect.any(Array), expect.any(Object));
  });

  it('should throw when no EDITOR env and no editor option', async () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;

    await expect(openEditor(['file.ts'])).rejects.toThrow(
      '$EDITOR environment variable is not set'
    );
  });
});