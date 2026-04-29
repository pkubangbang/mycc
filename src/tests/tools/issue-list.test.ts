/**
 * issue-list.test.ts - Tests for the issue_list tool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueListTool } from '../../tools/issue_list.js';
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

describe('issueListTool', () => {
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

  it('should list empty issues', async () => {
    mockIssue.printIssues = vi.fn().mockResolvedValue('No issues.');

    const result = await issueListTool.handler(ctx, {});

    expect(mockIssue.printIssues).toHaveBeenCalled();
    expect(result).toBe('No issues.');
  });

  it('should list multiple issues', async () => {
    const formattedOutput = `Issues:
  [ ] #1: First issue
  [>] #2: Second issue @test-agent
  [x] #3: Completed issue @developer`;
    mockIssue.printIssues = vi.fn().mockResolvedValue(formattedOutput);

    const result = await issueListTool.handler(ctx, {});

    expect(mockIssue.printIssues).toHaveBeenCalled();
    expect(result).toContain('Issues:');
    expect(result).toContain('#1');
    expect(result).toContain('#2');
    expect(result).toContain('#3');
  });

  it('should handle various issue statuses', async () => {
    const formattedOutput = `Issues:
  [ ] #1: Pending issue
  [>] #2: In progress issue @alice
  [x] #3: Completed issue @bob
  [!] #4: Failed issue
  [-] #5: Abandoned issue`;
    mockIssue.printIssues = vi.fn().mockResolvedValue(formattedOutput);

    const result = await issueListTool.handler(ctx, {});

    expect(result).toContain('[ ]'); // pending
    expect(result).toContain('[>]'); // in_progress
    expect(result).toContain('[x]'); // completed
    expect(result).toContain('[!]'); // failed
    expect(result).toContain('[-]'); // abandoned
  });

  it('should show blocking relationships in output', async () => {
    const formattedOutput = `Issues:
  [ ] #1: Blocked issue blocked:2,3
  [x] #2: Blocker 1
  [x] #3: Blocker 2`;
    mockIssue.printIssues = vi.fn().mockResolvedValue(formattedOutput);

    const result = await issueListTool.handler(ctx, {});

    expect(result).toContain('blocked:2,3');
  });

  it('should show owner for claimed issues', async () => {
    const formattedOutput = `Issues:
  [>] #1: Active issue @test-agent
  [ ] #2: Unclaimed issue`;
    mockIssue.printIssues = vi.fn().mockResolvedValue(formattedOutput);

    const result = await issueListTool.handler(ctx, {});

    expect(result).toContain('@test-agent');
    expect(result).not.toContain('@test-agent @'); // no duplicate
  });

  // ========== Edge Cases ==========

  it('should handle empty args object', async () => {
    mockIssue.printIssues = vi.fn().mockResolvedValue('No issues.');

    const result = await issueListTool.handler(ctx, {});

    expect(mockIssue.printIssues).toHaveBeenCalled();
    expect(result).toBe('No issues.');
  });

  it('should ignore extra parameters', async () => {
    mockIssue.printIssues = vi.fn().mockResolvedValue('No issues.');

    const result = await issueListTool.handler(ctx, {
      extra: 'parameter',
      another: 123,
    });

    expect(mockIssue.printIssues).toHaveBeenCalled();
    expect(result).toBe('No issues.');
  });

  it('should handle null args', async () => {
    mockIssue.printIssues = vi.fn().mockResolvedValue('No issues.');

    const result = await issueListTool.handler(ctx, null as unknown as Record<string, unknown>);

    expect(mockIssue.printIssues).toHaveBeenCalled();
    expect(result).toBe('No issues.');
  });

  // ========== Tool Metadata Tests ==========

  it('should have correct tool name', () => {
    expect(issueListTool.name).toBe('issue_list');
  });

  it('should have correct scope', () => {
    expect(issueListTool.scope).toEqual(['main', 'child']);
  });

  it('should have no required parameters', () => {
    expect(issueListTool.input_schema.required).toEqual([]);
  });

  it('should have empty properties object', () => {
    const props = issueListTool.input_schema.properties;
    expect(Object.keys(props || {}).length).toBe(0);
  });
});