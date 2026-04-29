/**
 * issue-claim.test.ts - Tests for the issue_claim tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueClaimTool } from '../../tools/issue_claim.js';
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

// Create a pending issue
function createPendingIssue(): Issue {
  return {
    id: 1,
    title: 'Test Issue',
    content: 'Test content',
    status: 'pending',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

// Create an in-progress issue
function createInProgressIssue(): Issue {
  return {
    id: 2,
    title: 'In Progress Issue',
    content: 'Already claimed',
    status: 'in_progress',
    owner: 'other-agent',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

// Create a completed issue
function createCompletedIssue(): Issue {
  return {
    id: 3,
    title: 'Completed Issue',
    content: 'Already done',
    status: 'completed',
    owner: 'some-agent',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

describe('issueClaimTool', () => {
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

  it('should claim a pending issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());
    mockIssue.claimIssue = vi.fn().mockResolvedValue(true);

    const result = await issueClaimTool.handler(ctx, {
      id: 1,
      owner: 'test-agent',
    });

    expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
    expect(mockIssue.claimIssue).toHaveBeenCalledWith(1, 'test-agent');
    expect(result).toBe('OK: #1');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_claim', 'Claimed issue #1 for test-agent');
  });

  it('should claim issue with different owner names', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());
    mockIssue.claimIssue = vi.fn().mockResolvedValue(true);

    const result = await issueClaimTool.handler(ctx, {
      id: 1,
      owner: 'developer-123',
    });

    expect(mockIssue.claimIssue).toHaveBeenCalledWith(1, 'developer-123');
    expect(result).toBe('OK: #1');
  });

  // ========== Error Case Tests ==========

  it('should reject missing id', async () => {
    const result = await issueClaimTool.handler(ctx, {
      owner: 'test-agent',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
    expect(mockIssue.claimIssue).not.toHaveBeenCalled();
  });

  it('should reject non-integer id', async () => {
    const result = await issueClaimTool.handler(ctx, {
      id: 'abc',
      owner: 'test-agent',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
  });

  it('should reject float id', async () => {
    const result = await issueClaimTool.handler(ctx, {
      id: 1.5,
      owner: 'test-agent',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
  });

  it('should reject missing owner', async () => {
    const result = await issueClaimTool.handler(ctx, {
      id: 1,
    });

    expect(result).toBe('Error: owner parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Missing or invalid owner parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
    expect(mockIssue.claimIssue).not.toHaveBeenCalled();
  });

  it('should reject empty owner', async () => {
    const result = await issueClaimTool.handler(ctx, {
      id: 1,
      owner: '',
    });

    expect(result).toBe('Error: owner parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Missing or invalid owner parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
  });

  it('should reject non-string owner', async () => {
    const result = await issueClaimTool.handler(ctx, {
      id: 1,
      owner: 123,
    });

    expect(result).toBe('Error: owner parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Missing or invalid owner parameter');
  });

  it('should return error for non-existent issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(undefined);

    const result = await issueClaimTool.handler(ctx, {
      id: 999,
      owner: 'test-agent',
    });

    expect(result).toBe('Error: Issue #999 not found');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_claim', 'Issue #999 not found');
    expect(mockIssue.claimIssue).not.toHaveBeenCalled();
  });

  it('should return error when claim fails (already claimed)', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());
    mockIssue.claimIssue = vi.fn().mockResolvedValue(false);

    const result = await issueClaimTool.handler(ctx, {
      id: 2,
      owner: 'test-agent',
    });

    expect(result).toBe('Error: Failed to claim issue #2. It may not be in pending status or is already claimed.');
    expect(ctx.core.brief).toHaveBeenCalledWith('warn', 'issue_claim', 'Failed to claim issue #2');
  });

  it('should return error when claim fails (completed)', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createCompletedIssue());
    mockIssue.claimIssue = vi.fn().mockResolvedValue(false);

    const result = await issueClaimTool.handler(ctx, {
      id: 3,
      owner: 'test-agent',
    });

    expect(result).toBe('Error: Failed to claim issue #3. It may not be in pending status or is already claimed.');
    expect(ctx.core.brief).toHaveBeenCalledWith('warn', 'issue_claim', 'Failed to claim issue #3');
  });

  // ========== Tool Metadata Tests ==========

  it('should have correct tool name', () => {
    expect(issueClaimTool.name).toBe('issue_claim');
  });

  it('should have correct scope', () => {
    expect(issueClaimTool.scope).toEqual(['main', 'child']);
  });

  it('should have required parameters', () => {
    expect(issueClaimTool.input_schema.required).toContain('id');
    expect(issueClaimTool.input_schema.required).toContain('owner');
  });
});