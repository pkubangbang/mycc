/**
 * wt_enter.test.ts - Tests for the worktree enter tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wtEnterTool } from '../../tools/wt_enter.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('wtEnterTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    // Override getWorkDir to be a mock for testing
    ctx.core.getWorkDir = vi.fn().mockReturnValue(tempDir);
    ctx.wt = {
      createWorkTree: vi.fn(),
      enterWorkTree: vi.fn(),
      leaveWorkTree: vi.fn(),
      printWorkTrees: vi.fn(),
      removeWorkTree: vi.fn(),
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('successful worktree entry', () => {
    it('should enter a worktree with valid name', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project/worktrees/feature-branch');

      const result = await wtEnterTool.handler(ctx, {
        name: 'feature-branch',
      });

      expect(result).toBe('OK: /project/worktrees/feature-branch');
      expect(ctx.wt.enterWorkTree).toHaveBeenCalledWith('feature-branch');
    });

    it('should call brief with info message on success', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project/worktrees/test');

      await wtEnterTool.handler(ctx, {
        name: 'test',
      });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'wt_enter', "Entered worktree 'test' at /project/worktrees/test");
    });

    it('should handle worktree names with hyphens', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project/worktrees/my-feature-branch');

      const result = await wtEnterTool.handler(ctx, {
        name: 'my-feature-branch',
      });

      expect(result).toBe('OK: /project/worktrees/my-feature-branch');
      expect(ctx.wt.enterWorkTree).toHaveBeenCalledWith('my-feature-branch');
    });

    it('should handle worktree names with underscores', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project/worktrees/my_branch');

      const result = await wtEnterTool.handler(ctx, {
        name: 'my_branch',
      });

      expect(result).toBe('OK: /project/worktrees/my_branch');
    });
  });

  describe('validation errors', () => {
    it('should return error when name is missing', async () => {
      const result = await wtEnterTool.handler(ctx, {
        name: '',
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'wt_enter', 'Missing or invalid name parameter');
    });

    it('should return error when name is not a string', async () => {
      const result = await wtEnterTool.handler(ctx, {
        name: 123 as unknown as string,
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });

    it('should return error when name is null', async () => {
      const result = await wtEnterTool.handler(ctx, {
        name: null as unknown as string,
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });

    it('should return error when name is undefined', async () => {
      const result = await wtEnterTool.handler(ctx, {
        name: undefined as unknown as string,
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });
  });

  describe('worktree errors', () => {
    it('should return error when worktree does not exist', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockRejectedValue(new Error('worktree \'nonexistent\' not found'));

      const result = await wtEnterTool.handler(ctx, {
        name: 'nonexistent',
      });

      expect(result).toBe("Error: worktree 'nonexistent' not found");
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'wt_enter', "Failed to enter worktree: worktree 'nonexistent' not found");
    });

    it('should handle permission denied errors', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockRejectedValue(new Error('Permission denied'));

      const result = await wtEnterTool.handler(ctx, {
        name: 'protected-worktree',
      });

      expect(result).toBe('Error: Permission denied');
    });

    it('should handle git errors gracefully', async () => {
      vi.mocked(ctx.wt.enterWorkTree).mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await wtEnterTool.handler(ctx, {
        name: 'test',
      });

      expect(result).toBe('Error: fatal: not a git repository');
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(wtEnterTool.name).toBe('wt_enter');
    });

    it('should have correct scope', () => {
      expect(wtEnterTool.scope).toEqual(['main', 'child']);
    });

    it('should require name parameter', () => {
      expect(wtEnterTool.input_schema.required).toContain('name');
    });

    it('should have correct description', () => {
      expect(wtEnterTool.description).toContain('Switch to a git worktree');
    });
  });
});