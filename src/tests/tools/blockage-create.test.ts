/**
 * blockage-create.test.ts - Tests for the blockage_create tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blockageCreateTool } from '../../tools/blockage_create.js';
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
    ctx = createMockContext(mockIssue);
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

  it('should have correct tool name', () => {
    expect(blockageCreateTool.name).toBe('blockage_create');
  });

  it('should have correct scope', () => {
    expect(blockageCreateTool.scope).toEqual(['main', 'child']);
  });

  it('should have required parameters', () => {
    expect(blockageCreateTool.input_schema.required).toContain('blocker');
    expect(blockageCreateTool.input_schema.required).toContain('blocked');
  });
});