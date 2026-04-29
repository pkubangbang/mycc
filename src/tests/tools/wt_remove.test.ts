/**
 * wt_remove.test.ts - Tests for the worktree removal tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wtRemoveTool } from '../../tools/wt_remove.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('wtRemoveTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    ctx.wt = {
      createWorkTree: vi.fn(async () => {}),
      enterWorkTree: vi.fn(async () => {}),
      leaveWorkTree: vi.fn(async () => {}),
      printWorkTrees: vi.fn(async () => {}),
      removeWorkTree: vi.fn(async () => {}),
      syncWorkTrees: vi.fn(async () => {}),
      getWorkTreePath: vi.fn(async () => ''),
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('successful worktree removal', () => {
    it('should remove a worktree with valid name', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockResolvedValue(undefined);

      const result = await wtRemoveTool.handler(ctx, {
        name: 'feature-branch',
      });

      expect(result).toBe('OK');
      expect(ctx.wt.removeWorkTree).toHaveBeenCalledWith('feature-branch');
    });

    it('should call brief with info message on success', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockResolvedValue(undefined);

      await wtRemoveTool.handler(ctx, {
        name: 'test-worktree',
      });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'wt_remove', "Removed worktree 'test-worktree'");
    });

    it('should handle worktree names with hyphens', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockResolvedValue(undefined);

      const result = await wtRemoveTool.handler(ctx, {
        name: 'my-feature-branch',
      });

      expect(result).toBe('OK');
      expect(ctx.wt.removeWorkTree).toHaveBeenCalledWith('my-feature-branch');
    });

    it('should handle worktree names with underscores', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockResolvedValue(undefined);

      const result = await wtRemoveTool.handler(ctx, {
        name: 'my_branch_name',
      });

      expect(result).toBe('OK');
      expect(ctx.wt.removeWorkTree).toHaveBeenCalledWith('my_branch_name');
    });
  });

  describe('validation errors', () => {
    it('should return error when name is missing', async () => {
      const result = await wtRemoveTool.handler(ctx, {
        name: '',
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'wt_remove', 'Missing or invalid name parameter');
    });

    it('should return error when name is not a string', async () => {
      const result = await wtRemoveTool.handler(ctx, {
        name: 123 as unknown as string,
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });

    it('should return error when name is null', async () => {
      const result = await wtRemoveTool.handler(ctx, {
        name: null as unknown as string,
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });

    it('should return error when name is undefined', async () => {
      const result = await wtRemoveTool.handler(ctx, {
        name: undefined as unknown as string,
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });
  });

  describe('git errors', () => {
    it('should propagate error when worktree does not exist', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockRejectedValue(new Error('worktree \'nonexistent\' not found'));

      await expect(wtRemoveTool.handler(ctx, {
        name: 'nonexistent',
      })).rejects.toThrow("worktree 'nonexistent' not found");
    });

    it('should propagate error when worktree is in use', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockRejectedValue(new Error('worktree \'feature\' is currently in use'));

      await expect(wtRemoveTool.handler(ctx, {
        name: 'feature',
      })).rejects.toThrow("worktree 'feature' is currently in use");
    });

    it('should propagate permission errors', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockRejectedValue(new Error('Permission denied'));

      await expect(wtRemoveTool.handler(ctx, {
        name: 'protected',
      })).rejects.toThrow('Permission denied');
    });

    it('should propagate error when not in a git repository', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockRejectedValue(new Error('fatal: not a git repository'));

      await expect(wtRemoveTool.handler(ctx, {
        name: 'test',
      })).rejects.toThrow('fatal: not a git repository');
    });

    it('should propagate error when trying to remove main worktree', async () => {
      vi.mocked(ctx.wt.removeWorkTree).mockRejectedValue(new Error('cannot remove main worktree'));

      await expect(wtRemoveTool.handler(ctx, {
        name: 'main',
      })).rejects.toThrow('cannot remove main worktree');
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(wtRemoveTool.name).toBe('wt_remove');
    });

    it('should have correct scope', () => {
      expect(wtRemoveTool.scope).toEqual(['main', 'child']);
    });

    it('should require name parameter', () => {
      expect(wtRemoveTool.input_schema.required).toContain('name');
    });

    it('should have correct description', () => {
      expect(wtRemoveTool.description).toContain('Remove a git worktree');
    });

    it('should note that branch is not deleted', () => {
      expect(wtRemoveTool.description).toContain('Does not delete the branch');
    });
  });
});