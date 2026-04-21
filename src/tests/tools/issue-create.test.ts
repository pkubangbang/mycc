/**
 * issue-create.test.ts - Tests for the issue_create tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueCreateTool } from '../../tools/issue_create.js';
import type { AgentContext, IssueModule, CoreModule } from '../../types.js';

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

describe('issueCreateTool', () => {
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

  it('should create an issue with title and content', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Test Issue',
      content: 'This is a test issue description',
    });

    expect(mockIssue.createIssue).toHaveBeenCalledWith(
      'Test Issue',
      'This is a test issue description',
      []
    );
    expect(result).toBe('OK: #1');
    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_create', 'Created issue #1: Test Issue');
  });

  it('should create an issue with blockedBy dependencies', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Blocked Issue',
      content: 'This depends on other issues',
      blockedBy: [1, 2, 3],
    });

    expect(mockIssue.createIssue).toHaveBeenCalledWith(
      'Blocked Issue',
      'This depends on other issues',
      [1, 2, 3]
    );
    expect(result).toBe('OK: #1');
  });

  it('should return the created issue ID', async () => {
    mockIssue.createIssue = vi.fn().mockResolvedValue(42);

    const result = await issueCreateTool.handler(ctx, {
      title: 'Another Issue',
      content: 'Description',
    });

    expect(result).toBe('OK: #42');
  });

  // ========== Error Case Tests ==========

  it('should reject missing title', async () => {
    const result = await issueCreateTool.handler(ctx, {
      content: 'Description without title',
    });

    expect(result).toBe('Error: title parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_create', 'Missing or invalid title parameter');
    expect(mockIssue.createIssue).not.toHaveBeenCalled();
  });

  it('should reject empty title', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: '',
      content: 'Description',
    });

    expect(result).toBe('Error: title parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_create', 'Missing or invalid title parameter');
    expect(mockIssue.createIssue).not.toHaveBeenCalled();
  });

  it('should reject non-string title', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 123,
      content: 'Description',
    });

    expect(result).toBe('Error: title parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_create', 'Missing or invalid title parameter');
    expect(mockIssue.createIssue).not.toHaveBeenCalled();
  });

  it('should reject missing content', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Test Issue',
    });

    expect(result).toBe('Error: content parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_create', 'Missing or invalid content parameter');
    expect(mockIssue.createIssue).not.toHaveBeenCalled();
  });

  it('should reject empty content', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Test Issue',
      content: '',
    });

    expect(result).toBe('Error: content parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_create', 'Missing or invalid content parameter');
    expect(mockIssue.createIssue).not.toHaveBeenCalled();
  });

  it('should reject non-string content', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Test Issue',
      content: { text: 'nested' },
    });

    expect(result).toBe('Error: content parameter is required and must be a string');
    expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_create', 'Missing or invalid content parameter');
    expect(mockIssue.createIssue).not.toHaveBeenCalled();
  });

  it('should handle empty blockedBy array', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Test Issue',
      content: 'Description',
      blockedBy: [],
    });

    expect(mockIssue.createIssue).toHaveBeenCalledWith(
      'Test Issue',
      'Description',
      []
    );
    expect(result).toBe('OK: #1');
  });

  it('should handle undefined blockedBy as empty array', async () => {
    const result = await issueCreateTool.handler(ctx, {
      title: 'Test Issue',
      content: 'Description',
      blockedBy: undefined,
    });

    expect(mockIssue.createIssue).toHaveBeenCalledWith(
      'Test Issue',
      'Description',
      []
    );
    expect(result).toBe('OK: #1');
  });

  // ========== Tool Metadata Tests ==========

  it('should have correct tool name', () => {
    expect(issueCreateTool.name).toBe('issue_create');
  });

  it('should have correct scope', () => {
    expect(issueCreateTool.scope).toEqual(['main', 'child']);
  });

  it('should have required parameters', () => {
    expect(issueCreateTool.input_schema.required).toContain('title');
    expect(issueCreateTool.input_schema.required).toContain('content');
  });

  it('should have optional blockedBy parameter', () => {
    const props = issueCreateTool.input_schema.properties;
    expect(props).toHaveProperty('blockedBy');
    expect(props).toHaveProperty('title');
    expect(props).toHaveProperty('content');
  });
});