/**
 * wt_print.test.ts - Tests for the worktree print/list tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wtPrintTool } from '../../tools/wt_print.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('wtPrintTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
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

  describe('successful worktree listing', () => {
    it('should list all worktrees', async () => {
      const worktreeList = `main       main     /project
feature-a  feature  /project/worktrees/feature-a`;
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue(worktreeList);

      const result = await wtPrintTool.handler(ctx, {});

      expect(result).toBe(worktreeList);
      expect(ctx.wt.printWorkTrees).toHaveBeenCalled();
    });

    it('should call brief with info message on success', async () => {
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue('main  main  /project');

      await wtPrintTool.handler(ctx, {});

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'wt_print', 'Listed worktrees');
    });

    it('should handle empty worktree list', async () => {
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue('');

      const result = await wtPrintTool.handler(ctx, {});

      expect(result).toBe('');
    });

    it('should handle worktree list with only main', async () => {
      const singleWorktree = 'main  main  /project';
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue(singleWorktree);

      const result = await wtPrintTool.handler(ctx, {});

      expect(result).toBe(singleWorktree);
    });

    it('should handle formatted worktree output', async () => {
      const formattedOutput = `NAME       BRANCH     PATH
main       main       /home/user/project
feature    feature    /home/user/project/worktrees/feature
hotfix     hotfix     /home/user/project/worktrees/hotfix`;
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue(formattedOutput);

      const result = await wtPrintTool.handler(ctx, {});

      expect(result).toContain('NAME');
      expect(result).toContain('BRANCH');
      expect(result).toContain('main');
      expect(result).toContain('feature');
      expect(result).toContain('hotfix');
    });
  });

  describe('error handling', () => {
    it('should propagate git errors', async () => {
      vi.mocked(ctx.wt.printWorkTrees).mockRejectedValue(new Error('fatal: not a git repository'));

      await expect(wtPrintTool.handler(ctx, {})).rejects.toThrow('fatal: not a git repository');
    });

    it('should handle permission errors', async () => {
      vi.mocked(ctx.wt.printWorkTrees).mockRejectedValue(new Error('Permission denied'));

      await expect(wtPrintTool.handler(ctx, {})).rejects.toThrow('Permission denied');
    });
  });

  describe('no parameters required', () => {
    it('should work with empty args object', async () => {
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue('worktree list');

      const result = await wtPrintTool.handler(ctx, {});

      expect(result).toBe('worktree list');
    });

    it('should ignore any extra parameters passed', async () => {
      vi.mocked(ctx.wt.printWorkTrees).mockResolvedValue('worktree list');

      const result = await wtPrintTool.handler(ctx, {
        name: 'ignored',
        extra: 'param',
      });

      expect(result).toBe('worktree list');
      expect(ctx.wt.printWorkTrees).toHaveBeenCalled();
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(wtPrintTool.name).toBe('wt_print');
    });

    it('should have correct scope', () => {
      expect(wtPrintTool.scope).toEqual(['main', 'child']);
    });

    it('should have no required parameters', () => {
      expect(wtPrintTool.input_schema.required).toEqual([]);
    });

    it('should have empty properties object', () => {
      expect(wtPrintTool.input_schema.properties).toEqual({});
    });

    it('should have correct description', () => {
      expect(wtPrintTool.description).toContain('List all git worktrees');
    });
  });
});