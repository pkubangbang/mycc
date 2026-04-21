/**
 * issue-comment.test.ts - Tests for the issue_comment tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueCommentTool } from '../../tools/issue_comment.js';
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

// Create a sample issue
function createSampleIssue(): Issue {
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

describe('issueCommentTool', () => {
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

  it('should add a comment to an issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createSampleIssue());

    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'This is a test comment',
    });

    expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
    expect(mockIssue.addComment).toHaveBeenCalledWith(1, 'This is a test comment', undefined);
    expect(result).toBe('OK');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_comment', 'Added comment to #1: "This is a test comment"');
  });

  it('should add a comment with poster name', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createSampleIssue());

    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'Great progress!',
      poster: 'alice',
    });

    expect(mockIssue.addComment).toHaveBeenCalledWith(1, 'Great progress!', 'alice');
    expect(result).toBe('OK');
  });

  it('should handle comment with special characters', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createSampleIssue());

    const specialComment = 'Code: `const x = 1;`\n**Bold** text\n```javascript\nconsole.log("hello");\n```';
    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: specialComment,
    });

    expect(mockIssue.addComment).toHaveBeenCalledWith(1, specialComment, undefined);
    expect(result).toBe('OK');
  });

  it('should handle very long comment', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createSampleIssue());

    const longComment = 'A'.repeat(1000);
    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: longComment,
    });

    expect(mockIssue.addComment).toHaveBeenCalledWith(1, longComment, undefined);
    expect(result).toBe('OK');
  });

  it('should add multiple comments sequentially', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createSampleIssue());

    // First comment
    const result1 = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'First comment',
    });
    expect(result1).toBe('OK');

    // Second comment
    const result2 = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'Second comment',
      poster: 'bob',
    });
    expect(result2).toBe('OK');

    expect(mockIssue.addComment).toHaveBeenCalledTimes(2);
  });

  // ========== Error Case Tests ==========

  it('should reject missing id', async () => {
    const result = await issueCommentTool.handler(ctx, {
      comment: 'Test comment',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Invalid id parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
    expect(mockIssue.addComment).not.toHaveBeenCalled();
  });

  it('should reject non-integer id', async () => {
    const result = await issueCommentTool.handler(ctx, {
      id: 'abc',
      comment: 'Test comment',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Invalid id parameter');
  });

  it('should reject float id', async () => {
    const result = await issueCommentTool.handler(ctx, {
      id: 1.5,
      comment: 'Test comment',
    });

    expect(result).toBe('Error: id must be an integer');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Invalid id parameter');
  });

  it('should reject missing comment', async () => {
    const result = await issueCommentTool.handler(ctx, {
      id: 1,
    });

    expect(result).toBe('Error: comment parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Missing or invalid comment parameter');
    expect(mockIssue.getIssue).not.toHaveBeenCalled();
    expect(mockIssue.addComment).not.toHaveBeenCalled();
  });

  it('should reject empty comment', async () => {
    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: '',
    });

    expect(result).toBe('Error: comment parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Missing or invalid comment parameter');
  });

  it('should reject non-string comment', async () => {
    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: { text: 'nested' },
    });

    expect(result).toBe('Error: comment parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Missing or invalid comment parameter');
  });

  it('should return error for non-existent issue', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(undefined);

    const result = await issueCommentTool.handler(ctx, {
      id: 999,
      comment: 'Test comment',
    });

    expect(result).toBe('Error: Issue #999 not found');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_comment', 'Issue #999 not found');
    expect(mockIssue.addComment).not.toHaveBeenCalled();
  });

  // ========== Edge Case Tests ==========

  it('should handle undefined poster as anonymous', async () => {
    mockIssue.getIssue = vi.fn().mockResolvedValue(createSampleIssue());

    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'Test comment',
      poster: undefined,
    });

    // Handler passes undefined to addComment which defaults to 'anonymous'
    expect(mockIssue.addComment).toHaveBeenCalledWith(1, 'Test comment', undefined);
    expect(result).toBe('OK');
  });

  it('should allow adding comment to pending issue', async () => {
    const pendingIssue: Issue = {
      id: 1,
      title: 'Pending Issue',
      content: 'Test content',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };
    mockIssue.getIssue = vi.fn().mockResolvedValue(pendingIssue);

    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'Note before claiming',
    });

    expect(result).toBe('OK');
    expect(mockIssue.addComment).toHaveBeenCalled();
  });

  it('should allow adding comment to completed issue', async () => {
    const completedIssue: Issue = {
      id: 1,
      title: 'Completed Issue',
      content: 'Test content',
      status: 'completed',
      owner: 'test-agent',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };
    mockIssue.getIssue = vi.fn().mockResolvedValue(completedIssue);

    const result = await issueCommentTool.handler(ctx, {
      id: 1,
      comment: 'Follow-up note',
    });

    expect(result).toBe('OK');
    expect(mockIssue.addComment).toHaveBeenCalled();
  });

  // ========== Tool Metadata Tests ==========

  it('should have correct tool name', () => {
    expect(issueCommentTool.name).toBe('issue_comment');
  });

  it('should have correct scope', () => {
    expect(issueCommentTool.scope).toEqual(['main', 'child']);
  });

  it('should have required parameters', () => {
    expect(issueCommentTool.input_schema.required).toContain('id');
    expect(issueCommentTool.input_schema.required).toContain('comment');
  });

  it('should have optional poster parameter', () => {
    const props = issueCommentTool.input_schema.properties;
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('comment');
    expect(props).toHaveProperty('poster');
  });
});