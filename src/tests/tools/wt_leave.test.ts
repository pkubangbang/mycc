/**
 * wt_leave.test.ts - Tests for the worktree leave tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wtLeaveTool } from '../../tools/wt_leave.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('wtLeaveTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    // Override getWorkDir to be a mock for testing
    ctx.core.getWorkDir = vi.fn().mockReturnValue(tempDir);
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

  describe('successful worktree exit', () => {
    it('should leave current worktree and return to project root', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project/root');

      const result = await wtLeaveTool.handler(ctx, {});

      expect(result).toBe('OK: /project/root');
      expect(ctx.wt.leaveWorkTree).toHaveBeenCalled();
    });

    it('should call brief with info message on success', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/home/user/project');

      await wtLeaveTool.handler(ctx, {});

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'wt_leave', 'Returned to project root: /home/user/project');
    });

    it('should handle being called when not in a worktree', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project/root');

      const result = await wtLeaveTool.handler(ctx, {});

      // Should still succeed even if already at root
      expect(result).toBe('OK: /project/root');
    });
  });

  describe('error handling', () => {
    it('should propagate errors from leaveWorkTree', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockRejectedValue(new Error('No worktree to leave'));

      await expect(wtLeaveTool.handler(ctx, {})).rejects.toThrow('No worktree to leave');
    });

    it('should handle git errors gracefully', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockRejectedValue(new Error('fatal: not a git repository'));

      await expect(wtLeaveTool.handler(ctx, {})).rejects.toThrow('fatal: not a git repository');
    });
  });

  describe('no parameters required', () => {
    it('should work with empty args object', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project');

      const result = await wtLeaveTool.handler(ctx, {});

      expect(result).toContain('OK:');
    });

    it('should ignore any extra parameters passed', async () => {
      vi.mocked(ctx.wt.leaveWorkTree).mockResolvedValue(undefined);
      vi.mocked(ctx.core.getWorkDir).mockReturnValue('/project');

      const result = await wtLeaveTool.handler(ctx, {
        name: 'ignored',
        branch: 'also-ignored',
      });

      expect(result).toContain('OK:');
      expect(ctx.wt.leaveWorkTree).toHaveBeenCalled();
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(wtLeaveTool.name).toBe('wt_leave');
    });

    it('should have correct scope', () => {
      expect(wtLeaveTool.scope).toEqual(['main', 'child']);
    });

    it('should have no required parameters', () => {
      expect(wtLeaveTool.input_schema.required).toEqual([]);
    });

    it('should have empty properties object', () => {
      expect(wtLeaveTool.input_schema.properties).toEqual({});
    });

    it('should have correct description', () => {
      expect(wtLeaveTool.description).toContain('Exit current worktree');
    });
  });
});