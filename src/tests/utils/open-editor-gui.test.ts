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

/** Helper: create a mock ChildProcess that emits 'spawn' then supports unref() */
function mockGuiProcess() {
  const unref = vi.fn();
  const on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
    if (event === 'spawn') {
      // Resolve on next tick to simulate async spawn
      setImmediate(() => callback());
    }
    return { on, unref } as unknown as ReturnType<typeof spawn>;
  });
  return { on, unref };
}

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
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10:5'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['--goto', 'file.ts:10:5'],
        expect.objectContaining({ stdio: 'ignore' })
      );
      expect(mockProc.unref).toHaveBeenCalled();
    });

    it('should spawn with --goto for line only (no column)', async () => {
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['--goto', 'file.ts:10'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('should spawn without --goto when no line number', async () => {
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['file.ts'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });
  });

  describe('Sublime', () => {
    it('should support --goto', async () => {
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        expect.any(Array),
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('should call unref after spawn event for GUI editors (confirmed child alive)', async () => {
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'atom' });

      // The spawn should happen without detached on Linux/macOS
      expect(mockSpawn).toHaveBeenCalledWith(
        'atom',
        expect.any(Array),
        expect.objectContaining({ stdio: 'ignore' })
      );
      // unref is called only after 'spawn' event
      expect(mockProc.unref).toHaveBeenCalled();
    });

    it('should handle multiple files', async () => {
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      await openEditor(['file1.ts:10', 'file2.ts:20:5'], { editor: 'vscode' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'code',
        ['--goto', 'file1.ts:10', '--goto', 'file2.ts:20:5'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('should handle empty file array', async () => {
      const mockProc = mockGuiProcess();
      mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
    const mockProc = mockGuiProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts'], { editor: 'xdg-open' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'xdg-open',
      ['file.ts'],
      expect.objectContaining({ stdio: 'ignore' })
    );
  });

  it('should treat unknown editors as non-terminal (GUI)', async () => {
    const mockProc = mockGuiProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts'], { editor: 'some-gui-editor' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'some-gui-editor',
      ['file.ts'],
      expect.objectContaining({ stdio: 'ignore' })
    );
  });

  it('should not use --goto for unknown editors (line/column stripped)', async () => {
    const mockProc = mockGuiProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

    await openEditor(['file.ts:10:5'], { editor: 'xdg-open' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'xdg-open',
      ['file.ts'],
      expect.any(Object)
    );
  });

  it('should handle spawn error for GUI editors', async () => {
    const on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'error') {
        setImmediate(() => callback(new Error('spawn ENOENT')));
      }
      return { on } as unknown as ReturnType<typeof spawn>;
    });
    mockSpawn.mockReturnValue({ on } as unknown as ReturnType<typeof spawn>);

    await expect(openEditor(['file.ts'], { editor: 'vscode' })).rejects.toThrow(
      'Failed to open editor: Failed to spawn editor: spawn ENOENT'
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
    const mockProc = mockGuiProcess();
    mockSpawn.mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

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
