/**
 * issue-publish.test.ts - Tests for the issue_publish tool
 *
 * issue_publish transitions an issue from 'draft' to 'pending', making it
 * visible to idle teammates for auto-claim.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issuePublishTool } from '../../tools/issue_publish.js';
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
    publishIssue: vi.fn().mockResolvedValue(true),
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
    readPictureCached: vi.fn(),
    requestGrant: vi.fn(async () => ({ approved: true })),
  };

  return {
    core,
    todo: {} as never,
    mail: {} as never,
    skill: {} as never,
    issue: issueModule,
    bg: {} as never,
    team: {} as never,
    wiki: {} as never,
  };
}

// Create a draft issue
function createDraftIssue(): Issue {
  return {
    id: 1,
    title: 'Draft Issue',
    content: 'Not yet published',
    status: 'draft',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

// Create a pending issue (already published)
function createPendingIssue(): Issue {
  return {
    id: 2,
    title: 'Pending Issue',
    content: 'Already published',
    status: 'pending',
    blockedBy: [],
    blocks: [],
    comments: [],
    createdAt: new Date(),
  };
}

describe('issuePublishTool', () => {
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

  it('should publish a draft issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createDraftIssue());
    mockIssue.publishIssue = vi.fn().mockResolvedValue(true);

    const result = await issuePublishTool.handler(ctx, {
      id: 1,
    });

    expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
    expect(mockIssue.publishIssue).toHaveBeenCalledWith(1);
    expect(result).toBe('No issues.');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_publish', 'Published issue #1: "Draft Issue"');
  });

  it('should return the issue list from printIssues', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createDraftIssue());
    mockIssue.publishIssue = vi.fn().mockResolvedValue(true);
    mockIssue.printIssues = vi.fn().mockResolvedValue('Issues:\n  [ ] #1: Draft Issue');

    const result = await issuePublishTool.handler(ctx, {
      id: 1,
    });

    expect(result).toBe('Issues:\n  [ ] #1: Draft Issue');
  });

  // ========== Error Case Tests ==========

  it('should reject missing id', async () => {
    const result = await issuePublishTool.handler(ctx, {});

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_publish', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
    expect(mockIssue.publishIssue).not.toHaveBeenCalled();
  });

  it('should reject non-integer id', async () => {
    const result = await issuePublishTool.handler(ctx, {
      id: 'abc',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_publish', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
  });

  it('should reject float id', async () => {
    const result = await issuePublishTool.handler(ctx, {
      id: 1.5,
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_publish', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
  });

  it('should return error for non-existent issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(undefined);

    const result = await issuePublishTool.handler(ctx, {
      id: 999,
    });

    expect(result).toBe('Error: Issue #999 not found');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_publish', 'Issue #999 not found');
    expect(mockIssue.publishIssue).not.toHaveBeenCalled();
  });

  it('should return error when publish fails (already pending)', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());
    mockIssue.publishIssue = vi.fn().mockResolvedValue(false);

    const result = await issuePublishTool.handler(ctx, {
      id: 2,
    });

    expect(result).toBe('Error: Failed to publish issue #2. It may not be in draft status (current: pending).');
    expect(ctx.core.brief).toHaveBeenCalledWith('warn', 'issue_publish', 'Failed to publish issue #2');
  });

  // ========== Tool Metadata Tests ==========

  it('should have correct tool name', () => {
    expect(issuePublishTool.name).toBe('issue_publish');
  });

  it('should have correct scope', () => {
    expect(issuePublishTool.scope).toEqual(['main', 'child']);
  });

  it('should have required id parameter', () => {
    expect(issuePublishTool.input_schema.required).toContain('id');
  });

  it('should have only id property', () => {
    const props = issuePublishTool.input_schema.properties;
    expect(props).toHaveProperty('id');
    expect(Object.keys(props || {})).toHaveLength(1);
  });
});