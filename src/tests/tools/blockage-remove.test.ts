/**
 * blockage-remove.test.ts - Tests for the blockage_remove tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blockageRemoveTool } from '../../tools/blockage_remove.js';
import type { AgentContext, IssueModule, CoreModule, Issue } from '../../types.js';

// Factory to create mock issue module
function createMockIssueModule(): IssueModule {
  return {
    createIssue: vi.fn().mockResolvedValue(1),
    getIssue: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue([]),
    printIssues: vi.fn().mockResolvedValue('No issues.'),
    printIssue: vi.fn().mockResolvedValue('Issue #1 not found.'),
    claimIssue: vi.fn().mockResolvedValue(true),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    createBlockage: vi.fn().mockResolvedValue(undefined),
    removeBlockage: vi.fn().mockResolvedValue(undefined),
  };
}

// Factory to create mock context
function createMockContext(issueModule: IssueModule): AgentContext {
  const core: CoreModule = {
    getWorkDir: () => '/tmp/test',
    setWorkDir: vi.fn(),
    getName: () => 'test-agent',
    brief: vi.fn(),
    verbose: vi.fn(),
    question: vi.fn(),
    webSearch: vi.fn(),
    webFetch: vi.fn(),
    imgDescribe: vi.fn(),
    requestGrant: vi.fn(async () => ({ approved: true })),
  };

  return {
    core,
    todo: {} as never,
    mail: {} as never,
    skill: {} as never,
    issue: issueModule,
    bg: {} as never,
    wt: {} as never,
    team: {} as never,
    wiki: {} as never,
  };
}

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
    ctx = createMockContext(mockIssue);
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

  it('should have correct tool name', () => {
    expect(blockageRemoveTool.name).toBe('blockage_remove');
  });

  it('should have correct scope', () => {
    expect(blockageRemoveTool.scope).toEqual(['main', 'child']);
  });

  it('should have required parameters', () => {
    expect(blockageRemoveTool.input_schema.required).toContain('blocker');
    expect(blockageRemoveTool.input_schema.required).toContain('blocked');
  });
});