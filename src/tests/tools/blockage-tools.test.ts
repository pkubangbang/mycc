// blockage_* tools — merged from the two per-tool files

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blockageCreateTool } from '../../tools/blockage_create.js';
import type { AgentContext, IssueModule, Issue } from '../../types.js';
import { createMockContext, createMockIssue } from '../test-utils/index.js';
import { blockageRemoveTool } from '../../tools/blockage_remove.js';

describe('blockage-create', () => {
  /**
   * blockage-create.test.ts - Tests for the blockage_create tool
   */



  // Mock context built on the shared factories. printIssues/printIssue keep the
  // two fixtures these tests assert on; everything else comes from the defaults.
  function createMockIssueModule(): IssueModule {
    return createMockIssue({
      createIssue: vi.fn(async () => 1),
      printIssues: vi.fn(async () => 'No issues.'),
      printIssue: vi.fn(async () => 'Issue #1 not found.'),
    });
  }

  // Factory to create mock context

  // Create sample issues
  function createBlockerIssue(): Issue {
    return {
      id: 1,
      title: 'Blocker Issue',
      content: 'This blocks another issue',
      status: 'in_progress',
      owner: 'test-agent',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };
  }

  function createBlockedIssue(): Issue {
    return {
      id: 2,
      title: 'Blocked Issue',
      content: 'This is blocked',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };
  }

  describe('blockageCreateTool', () => {
    let mockIssue: IssueModule;
    let ctx: AgentContext;

    beforeEach(() => {
      mockIssue = createMockIssueModule();
      // Spread rather than passing `issue:` so ctx.issue stays aliased to
      // mockIssue — several tests replace a method on mockIssue after setup.
      ctx = { ...createMockContext({ workdir: '/tmp/test' }), issue: mockIssue };
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    // ========== Happy Path Tests ==========

    it('should create a blockage between two issues', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(createBlockerIssue());
          if (id === 2) return Promise.resolve(createBlockedIssue());
          return Promise.resolve(undefined);
        });

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
      expect(mockIssue.getIssue).toHaveBeenCalledWith(2);
      expect(mockIssue.createBlockage).toHaveBeenCalledWith(1, 2);
      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'blockage_create', 'Created blockage: #1 blocks #2');
    });

    it('should create blockage with larger issue IDs', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createBlockerIssue());

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 100,
        blocked: 200,
      });

      expect(mockIssue.createBlockage).toHaveBeenCalledWith(100, 200);
      expect(result).toBe('OK');
    });

    // ========== Error Case Tests ==========

    it('should reject missing blocker', async () => {
      const result = await blockageCreateTool.handler(ctx, {
        blocked: 2,
      });

      expect(result).toBe('Error: blocker must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Invalid blocker parameter');
      expect(mockIssue.createBlockage).not.toHaveBeenCalled();
    });

    it('should reject missing blocked', async () => {
      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
      });

      expect(result).toBe('Error: blocked must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Invalid blocked parameter');
      expect(mockIssue.createBlockage).not.toHaveBeenCalled();
    });

    it('should reject non-integer blocker', async () => {
      const result = await blockageCreateTool.handler(ctx, {
        blocker: 'abc',
        blocked: 2,
      });

      expect(result).toBe('Error: blocker must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Invalid blocker parameter');
    });

    it('should reject non-integer blocked', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createBlockerIssue());

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
        blocked: 'xyz',
      });

      expect(result).toBe('Error: blocked must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Invalid blocked parameter');
    });

    it('should reject float blocker', async () => {
      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1.5,
        blocked: 2,
      });

      expect(result).toBe('Error: blocker must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Invalid blocker parameter');
    });

    it('should reject float blocked', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createBlockerIssue());

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
        blocked: 2.5,
      });

      expect(result).toBe('Error: blocked must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Invalid blocked parameter');
    });

    it('should reject self-blocking', async () => {
      const issue = createBlockerIssue();
      mockIssue.getIssue = vi.fn().mockResolvedValue(issue);

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
        blocked: 1,
      });

      expect(result).toBe('Error: An issue cannot block itself');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Self-blocking not allowed');
      expect(mockIssue.createBlockage).not.toHaveBeenCalled();
    });

    it('should return error when blocker issue not found', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(undefined); // blocker not found
          if (id === 2) return Promise.resolve(createBlockedIssue());
          return Promise.resolve(undefined);
        });

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(result).toBe('Error: Blocker issue #1 not found');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Blocker issue #1 not found');
      expect(mockIssue.createBlockage).not.toHaveBeenCalled();
    });

    it('should return error when blocked issue not found', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(createBlockerIssue());
          if (id === 2) return Promise.resolve(undefined); // blocked not found
          return Promise.resolve(undefined);
        });

      const result = await blockageCreateTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(result).toBe('Error: Blocked issue #2 not found');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_create', 'Blocked issue #2 not found');
      expect(mockIssue.createBlockage).not.toHaveBeenCalled();
    });

    // ========== Tool Metadata Tests ==========

  });
});

describe('blockage-remove', () => {
  /**
   * blockage-remove.test.ts - Tests for the blockage_remove tool
   */



  // Mock context built on the shared factories. printIssues/printIssue keep the
  // two fixtures these tests assert on; everything else comes from the defaults.
  function createMockIssueModule(): IssueModule {
    return createMockIssue({
      createIssue: vi.fn(async () => 1),
      printIssues: vi.fn(async () => 'No issues.'),
      printIssue: vi.fn(async () => 'Issue #1 not found.'),
    });
  }

  // Factory to create mock context

  // Create sample issues
  function createBlockerIssue(): Issue {
    return {
      id: 1,
      title: 'Blocker Issue',
      content: 'This was blocking another issue',
      status: 'completed',
      owner: 'test-agent',
      blockedBy: [],
      blocks: [2],
      comments: [],
      createdAt: new Date(),
    };
  }

  function createBlockedIssue(): Issue {
    return {
      id: 2,
      title: 'Blocked Issue',
      content: 'This was blocked',
      status: 'pending',
      blockedBy: [1],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };
  }

  describe('blockageRemoveTool', () => {
    let mockIssue: IssueModule;
    let ctx: AgentContext;

    beforeEach(() => {
      mockIssue = createMockIssueModule();
      // Spread rather than passing `issue:` so ctx.issue stays aliased to
      // mockIssue — several tests replace a method on mockIssue after setup.
      ctx = { ...createMockContext({ workdir: '/tmp/test' }), issue: mockIssue };
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    // ========== Happy Path Tests ==========

    it('should remove a blockage between two issues', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(createBlockerIssue());
          if (id === 2) return Promise.resolve(createBlockedIssue());
          return Promise.resolve(undefined);
        });

      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
      expect(mockIssue.getIssue).toHaveBeenCalledWith(2);
      expect(mockIssue.removeBlockage).toHaveBeenCalledWith(1, 2);
      expect(result).toBe('OK');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'blockage_remove', 'Removed blockage: #1 no longer blocks #2');
    });

    it('should remove blockage with larger issue IDs', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createBlockerIssue());

      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 100,
        blocked: 200,
      });

      expect(mockIssue.removeBlockage).toHaveBeenCalledWith(100, 200);
      expect(result).toBe('OK');
    });

    it('should handle removing non-existent blockage (idempotent)', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(createBlockerIssue());
          if (id === 2) return Promise.resolve(createBlockedIssue());
          return Promise.resolve(undefined);
        });

      // Even if blockage doesn't exist, the tool should succeed
      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(mockIssue.removeBlockage).toHaveBeenCalledWith(1, 2);
      expect(result).toBe('OK');
    });

    // ========== Error Case Tests ==========

    it('should reject missing blocker', async () => {
      const result = await blockageRemoveTool.handler(ctx, {
        blocked: 2,
      });

      expect(result).toBe('Error: blocker must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Invalid blocker parameter');
      expect(mockIssue.removeBlockage).not.toHaveBeenCalled();
    });

    it('should reject missing blocked', async () => {
      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
      });

      expect(result).toBe('Error: blocked must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Invalid blocked parameter');
      expect(mockIssue.removeBlockage).not.toHaveBeenCalled();
    });

    it('should reject non-integer blocker', async () => {
      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 'abc',
        blocked: 2,
      });

      expect(result).toBe('Error: blocker must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Invalid blocker parameter');
    });

    it('should reject non-integer blocked', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createBlockerIssue());

      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
        blocked: 'xyz',
      });

      expect(result).toBe('Error: blocked must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Invalid blocked parameter');
    });

    it('should reject float blocker', async () => {
      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1.5,
        blocked: 2,
      });

      expect(result).toBe('Error: blocker must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Invalid blocker parameter');
    });

    it('should reject float blocked', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createBlockerIssue());

      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
        blocked: 2.5,
      });

      expect(result).toBe('Error: blocked must be an integer');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Invalid blocked parameter');
    });

    it('should return error when blocker issue not found', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(undefined); // blocker not found
          if (id === 2) return Promise.resolve(createBlockedIssue());
          return Promise.resolve(undefined);
        });

      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(result).toBe('Error: Blocker issue #1 not found');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Blocker issue #1 not found');
      expect(mockIssue.removeBlockage).not.toHaveBeenCalled();
    });

    it('should return error when blocked issue not found', async () => {
      mockIssue.getIssue = vi.fn()
        .mockImplementation((id: number) => {
          if (id === 1) return Promise.resolve(createBlockerIssue());
          if (id === 2) return Promise.resolve(undefined); // blocked not found
          return Promise.resolve(undefined);
        });

      const result = await blockageRemoveTool.handler(ctx, {
        blocker: 1,
        blocked: 2,
      });

      expect(result).toBe('Error: Blocked issue #2 not found');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'blockage_remove', 'Blocked issue #2 not found');
      expect(mockIssue.removeBlockage).not.toHaveBeenCalled();
    });

    // ========== Tool Metadata Tests ==========

  });
});
