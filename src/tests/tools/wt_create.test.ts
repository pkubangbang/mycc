/**
 * wt_create.test.ts - Tests for the worktree creation tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wtCreateTool } from '../../tools/wt_create.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

describe('wtCreateTool', () => {
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

  describe('successful worktree creation', () => {
    it('should create a worktree with valid parameters', async () => {
      vi.mocked(ctx.wt.createWorkTree).mockResolvedValue('/project/worktrees/feature-branch');

      const result = await wtCreateTool.handler(ctx, {
        name: 'feature-branch',
        branch: 'feature/new-feature',
      });

      expect(result).toBe('/project/worktrees/feature-branch');
      expect(ctx.wt.createWorkTree).toHaveBeenCalledWith('feature-branch', 'feature/new-feature');
    });

    it('should call brief with info message on success', async () => {
      vi.mocked(ctx.wt.createWorkTree).mockResolvedValue('/project/worktrees/test');

      await wtCreateTool.handler(ctx, {
        name: 'test',
        branch: 'test-branch',
      });

      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'wt_create', "Created worktree 'test' on branch test-branch");
    });

    it('should handle worktree names with special characters', async () => {
      vi.mocked(ctx.wt.createWorkTree).mockResolvedValue('/project/worktrees/feature-123');

      const result = await wtCreateTool.handler(ctx, {
        name: 'feature-123',
        branch: 'feature/TICKET-123',
      });

      expect(result).toBe('/project/worktrees/feature-123');
      expect(ctx.wt.createWorkTree).toHaveBeenCalledWith('feature-123', 'feature/TICKET-123');
    });
  });

  describe('validation errors', () => {
    it('should return error when name is missing', async () => {
      const result = await wtCreateTool.handler(ctx, {
        name: '',
        branch: 'test-branch',
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'wt_create', 'Missing or invalid name parameter');
    });

    it('should return error when name is not a string', async () => {
      const result = await wtCreateTool.handler(ctx, {
        name: 123 as unknown as string,
        branch: 'test-branch',
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });

    it('should return error when branch is missing', async () => {
      const result = await wtCreateTool.handler(ctx, {
        name: 'test-worktree',
        branch: '',
      });

      expect(result).toBe('Error: branch parameter is required and must be a string');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'wt_create', 'Missing or invalid branch parameter');
    });

    it('should return error when branch is not a string', async () => {
      const result = await wtCreateTool.handler(ctx, {
        name: 'test-worktree',
        branch: { invalid: true } as unknown as string,
      });

      expect(result).toBe('Error: branch parameter is required and must be a string');
    });

    it('should return error when name is null', async () => {
      const result = await wtCreateTool.handler(ctx, {
        name: null as unknown as string,
        branch: 'test-branch',
      });

      expect(result).toBe('Error: name parameter is required and must be a string');
    });

    it('should return error when branch is undefined', async () => {
      const result = await wtCreateTool.handler(ctx, {
        name: 'test-worktree',
        branch: undefined as unknown as string,
      });

      expect(result).toBe('Error: branch parameter is required and must be a string');
    });
  });

  describe('git errors', () => {
    it('should propagate git errors from createWorkTree', async () => {
      vi.mocked(ctx.wt.createWorkTree).mockRejectedValue(new Error('fatal: branch \'test\' already exists'));

      await expect(wtCreateTool.handler(ctx, {
        name: 'test',
        branch: 'test',
      })).rejects.toThrow("fatal: branch 'test' already exists");
    });

    it('should propagate error when worktree name conflicts', async () => {
      vi.mocked(ctx.wt.createWorkTree).mockRejectedValue(new Error('worktree \'test\' already exists'));

      await expect(wtCreateTool.handler(ctx, {
        name: 'test',
        branch: 'test-branch',
      })).rejects.toThrow("worktree 'test' already exists");
    });

    it('should propagate error when not in a git repository', async () => {
      vi.mocked(ctx.wt.createWorkTree).mockRejectedValue(new Error('fatal: not a git repository'));

      await expect(wtCreateTool.handler(ctx, {
        name: 'test',
        branch: 'test-branch',
      })).rejects.toThrow('fatal: not a git repository');
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(wtCreateTool.name).toBe('wt_create');
    });

    it('should have correct scope', () => {
      expect(wtCreateTool.scope).toEqual(['main', 'child']);
    });

    it('should require name and branch parameters', () => {
      expect(wtCreateTool.input_schema.required).toContain('name');
      expect(wtCreateTool.input_schema.required).toContain('branch');
    });

    it('should have correct description', () => {
      expect(wtCreateTool.description).toContain('Create a new git worktree');
    });
  });
});