/**
 * open-editor-terminal.test.ts - Terminal editor tests
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

describe('openEditor - terminal editors', () => {
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

  describe('Vim', () => {
    it('should spawn with cursor positioning for line numbers', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10'], { editor: 'vim' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'vim',
        ['+call cursor(10, 1)', 'file.ts'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('should spawn with cursor positioning for line and column', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10:5'], { editor: 'vim' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'vim',
        ['+call cursor(10, 5)', 'file.ts'],
        expect.any(Object)
      );
    });

    it('should use default column 1 when only line specified', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:42'], { editor: 'vim' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'vim',
        ['+call cursor(42, 1)', 'file.ts'],
        expect.any(Object)
      );
    });

    it('should spawn without cursor args when no line number', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vim' });

      expect(mockSpawn).toHaveBeenCalledWith('vim', ['file.ts'], expect.any(Object));
    });

    it('should handle multiple files with cursor positioning', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file1.ts:5', 'file2.ts'], { editor: 'vim' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'vim',
        ['+call cursor(5, 1)', 'file1.ts', 'file2.ts'],
        expect.any(Object)
      );
    });
  });

  describe('Neovim', () => {
    it('should spawn with cursor positioning', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:25:8'], { editor: 'neovim' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'nvim',
        ['+call cursor(25, 8)', 'file.ts'],
        expect.any(Object)
      );
    });

    it('should spawn by binary name (nvim)', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10'], { editor: 'nvim' });

      expect(mockSpawn).toHaveBeenCalledWith('nvim', expect.any(Array), expect.any(Object));
    });
  });

  describe('Nano', () => {
    it('should spawn with file only (line/column stripped - not supported)', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts:10:5'], { editor: 'nano' });

      expect(mockSpawn).toHaveBeenCalledWith('nano', ['file.ts'], expect.any(Object));
    });
  });

  describe('Emacs', () => {
    it('should spawn with file (terminal mode)', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'emacs' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'emacs',
        ['file.ts'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });

  describe('Terminal editor behavior', () => {
    it('should use stdio: inherit for terminal editors', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vim' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'vim',
        expect.any(Array),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('should not use detached for terminal editors', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(0);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vim' });

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[2]).not.toHaveProperty('detached', true);
    });

    it('should wait for terminal editor to close', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await openEditor(['file.ts'], { editor: 'vim' });

      expect(mockProcess.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockProcess.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('Error handling', () => {
    it('should reject when terminal editor exits with non-zero code', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'close') callback(1);
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await expect(openEditor(['file.ts'], { editor: 'vim' })).rejects.toThrow(
        'Editor exited with code 1'
      );
    });

    it('should handle spawn error for terminal editors', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'error') {
            callback(new Error('spawn vim ENOENT'));
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await expect(openEditor(['file.ts'], { editor: 'vim' })).rejects.toThrow(
        'Failed to open editor: spawn vim ENOENT'
      );
    });

    it('should handle editor not found error', async () => {
      const mockProcess = {
        on: vi.fn((event, callback) => {
          if (event === 'error') {
            callback(new Error('spawn nonexistent-editor ENOENT'));
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await expect(openEditor(['file.ts'], { editor: 'nonexistent-editor' })).rejects.toThrow();
    });
  });
});