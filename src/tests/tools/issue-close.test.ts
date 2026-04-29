/**
 * issue-close.test.ts - Tests for the issue_close tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueCloseTool } from '../../tools/issue_close.js';
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

// Create an in-progress issue
function createInProgressIssue(): Issue {
  return {
    id: 1,
    title: 'Test Issue',
    content: 'Test content',
    status: 'in_progress',
    owner: 'test-agent',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

// Create a pending issue
function createPendingIssue(): Issue {
  return {
    id: 2,
    title: 'Pending Issue',
    content: 'Pending content',
    status: 'pending',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

// Create an issue that blocks others
function createBlockingIssue(): Issue {
  return {
    id: 3,
    title: 'Blocking Issue',
    content: 'Blocks others',
    status: 'in_progress',
    blockedBy: [],
    blocks: [4, 5],
    comments: [],
    createdAt: new Date(),
  };
}

describe('issueCloseTool', () => {
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

  it('should close an issue as completed', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'completed',
    });

    expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
    expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'completed', undefined, undefined);
    expect(result).toBe('OK: #1');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as completed');
  });

  it('should close an issue as failed', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'failed',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'failed', undefined, undefined);
    expect(result).toBe('OK: #1');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as failed');
  });

  it('should close an issue as abandoned', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'abandoned',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'abandoned', undefined, undefined);
    expect(result).toBe('OK: #1');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as abandoned');
  });

  it('should close an issue with a comment', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'completed',
      comment: 'All tests passing',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'completed', 'All tests passing', undefined);
    expect(result).toBe('OK: #1');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as completed: "All tests passing"');
  });

  it('should close an issue with comment and poster', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'completed',
      comment: 'Done',
      poster: 'developer',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'completed', 'Done', 'developer');
    expect(result).toBe('OK: #1');
  });

  it('should close a pending issue directly', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 2,
      status: 'abandoned',
      comment: 'Not needed anymore',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalledWith(2, 'abandoned', 'Not needed anymore', undefined);
    expect(result).toBe('OK: #2');
  });

  // ========== Error Case Tests ==========

  it('should reject missing id', async () => {
    const result = await issueCloseTool.handler(ctx, {
      status: 'completed',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
    expect(mockIssue.closeIssue).not.toHaveBeenCalled();
  });

  it('should reject non-integer id', async () => {
    const result = await issueCloseTool.handler(ctx, {
      id: 'abc',
      status: 'completed',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Invalid id parameter');
  });

  it('should reject float id', async () => {
    const result = await issueCloseTool.handler(ctx, {
      id: 1.5,
      status: 'completed',
    });

    expect(result).toBe('Error: id must be an integer');
  });

  it('should reject missing status', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
    });

    expect(result).toBe('Error: status must be one of: completed, failed, abandoned');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Invalid status: undefined');
  });

  it('should reject invalid status', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'invalid_status',
    });

    expect(result).toBe('Error: status must be one of: completed, failed, abandoned');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Invalid status: invalid_status');
  });

  it('should reject status not in allowed list', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'pending', // pending is a valid status but not for closing
    });

    expect(result).toBe('Error: status must be one of: completed, failed, abandoned');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Invalid status: pending');
  });

  it('should return error for non-existent issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(undefined);

    const result = await issueCloseTool.handler(ctx, {
      id: 999,
      status: 'completed',
    });

    expect(result).toBe('Error: Issue #999 not found');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Issue #999 not found');
    expect(mockIssue.closeIssue).not.toHaveBeenCalled();
  });

  // ========== State Transition Tests ==========

  it('should allow closing an in_progress issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 1,
      status: 'completed',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalled();
    expect(result).toBe('OK: #1');
  });

  it('should allow closing a pending issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());

    const result = await issueCloseTool.handler(ctx, {
      id: 2,
      status: 'failed',
    });

    expect(mockIssue.closeIssue).toHaveBeenCalled();
    expect(result).toBe('OK: #2');
  });

  // ========== Blockage Unblocking Tests ==========

  it('should close issue that blocks others (verifies blockage removal)', async () => {
    const blockingIssue = createBlockingIssue();
    mockIssue.getIssue = vi.fn().mockResolvedValue(blockingIssue);

    const result = await issueCloseTool.handler(ctx, {
      id: 3,
      status: 'completed',
    });

    // The handler calls closeIssue which should handle blockage removal
    expect(mockIssue.closeIssue).toHaveBeenCalledWith(3, 'completed', undefined, undefined);
    expect(result).toBe('OK: #3');
  });

  // ========== Tool Metadata Tests ==========

  it('should have correct tool name', () => {
    expect(issueCloseTool.name).toBe('issue_close');
  });

  it('should have correct scope', () => {
    expect(issueCloseTool.scope).toEqual(['main', 'child']);
  });

  it('should have required parameters', () => {
    expect(issueCloseTool.input_schema.required).toContain('id');
    expect(issueCloseTool.input_schema.required).toContain('status');
  });

  it('should have optional comment and poster parameters', () => {
    const props = issueCloseTool.input_schema.properties;
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('status');
    expect(props).toHaveProperty('comment');
    expect(props).toHaveProperty('poster');
  });

  it('should have status enum defined', () => {
    const statusProp = issueCloseTool.input_schema.properties?.status as { enum?: string[] };
    expect(statusProp.enum).toEqual(['completed', 'failed', 'abandoned']);
  });
});