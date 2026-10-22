// issue_* tools — merged from the six per-tool files

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueCreateTool } from '../../tools/issue_create.js';
import { createMockContext, createMockIssue } from '../test-utils/index.js';
import { issueListTool } from '../../tools/issue_list.js';
import { issueClaimTool } from '../../tools/issue_claim.js';
import { issueCloseTool } from '../../tools/issue_close.js';
import { issueCommentTool } from '../../tools/issue_comment.js';
import { issuePublishTool } from '../../tools/issue_publish.js';
import type { AgentContext, Issue, IssueModule } from '../../types.js';

describe('issue-create', () => {
  /**
   * issue-create.test.ts - Tests for the issue_create tool
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

  describe('issueCreateTool', () => {
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
      expect(result).toContain('No issues.');
      expect(result).toContain('Issue #1 is in DRAFT status');
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
      expect(result).toContain('No issues.');
    });

    it('should return the issue list from printIssues', async () => {
      mockIssue.createIssue = vi.fn().mockResolvedValue(42);
      mockIssue.printIssues = vi.fn().mockResolvedValue('Issue #42: Test');

      const result = await issueCreateTool.handler(ctx, {
        title: 'Another Issue',
        content: 'Description',
      });

      expect(result).toContain('Issue #42: Test');
      expect(result).toContain('Issue #42 is in DRAFT status');
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
      expect(result).toContain('No issues.');
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
      expect(result).toContain('No issues.');
    });

    // ========== Tool Metadata Tests ==========

  });
});

describe('issue-list', () => {
  /**
   * issue-list.test.ts - Tests for the issue_list tool
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

  describe('issueListTool', () => {
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

    it('should have empty properties object', () => {
      const props = issueListTool.input_schema.properties;
      expect(Object.keys(props || {}).length).toBe(0);
    });
  });
});

describe('issue-claim', () => {
  /**
   * issue-claim.test.ts - Tests for the issue_claim tool
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
      // Spread rather than passing `issue:` so ctx.issue stays aliased to
      // mockIssue — several tests replace a method on mockIssue after setup.
      ctx = { ...createMockContext({ workdir: '/tmp/test' }), issue: mockIssue };
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
      expect(result).toBe('No issues.');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_claim', 'Claimed issue #1: "Test Issue"', '@test-agent');
    });

    it('should claim issue with different owner names', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());
      mockIssue.claimIssue = vi.fn().mockResolvedValue(true);

      const result = await issueClaimTool.handler(ctx, {
        id: 1,
        owner: 'developer-123',
      });

      expect(mockIssue.claimIssue).toHaveBeenCalledWith(1, 'developer-123');
      expect(result).toBe('No issues.');
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

  });
});

describe('issue-close', () => {
  /**
   * issue-close.test.ts - Tests for the issue_close tool
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
      // Spread rather than passing `issue:` so ctx.issue stays aliased to
      // mockIssue — several tests replace a method on mockIssue after setup.
      ctx = { ...createMockContext({ workdir: '/tmp/test' }), issue: mockIssue };
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
        comment: 'Resolved',
      });

      expect(mockIssue.getIssue).toHaveBeenCalledWith(1);
      expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'completed', 'Resolved', undefined);
      expect(result).toBe('No issues.');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as completed: "Resolved"');
    });

    it('should close an issue as failed', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'failed',
        comment: 'Blocked by dependency',
      });

      expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'failed', 'Blocked by dependency', undefined);
      expect(result).toBe('No issues.');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as failed: "Blocked by dependency"');
    });

    it('should close an issue as abandoned', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'abandoned',
        comment: 'Out of scope',
      });

      expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'abandoned', 'Out of scope', undefined);
      expect(result).toBe('No issues.');
      expect(ctx.core.brief).toHaveBeenCalledWith('info', 'issue_close', 'Closed #1 as abandoned: "Out of scope"');
    });

    it('should close an issue with a comment', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'completed',
        comment: 'All tests passing',
      });

      expect(mockIssue.closeIssue).toHaveBeenCalledWith(1, 'completed', 'All tests passing', undefined);
      expect(result).toBe('No issues.');
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
      expect(result).toBe('No issues.');
    });

    it('should close a pending issue directly', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 2,
        status: 'abandoned',
        comment: 'Not needed anymore',
      });

      expect(mockIssue.closeIssue).toHaveBeenCalledWith(2, 'abandoned', 'Not needed anymore', undefined);
      expect(result).toBe('No issues.');
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
        comment: 'Closing',
      });

      expect(result).toBe('Error: Issue #999 not found');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Issue #999 not found');
      expect(mockIssue.closeIssue).not.toHaveBeenCalled();
    });

    // ========== Comment Requirement Tests ==========

    it('should reject missing comment', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'completed',
      });

      expect(result).toBe('Error: comment is required to explain the resolution or reason for closure. Provide a non-empty comment.');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Missing or empty comment');
      expect(mockIssue.getIssue).not.toHaveBeenCalled();
      expect(mockIssue.closeIssue).not.toHaveBeenCalled();
    });

    it('should reject empty string comment', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'completed',
        comment: '',
      });

      expect(result).toBe('Error: comment is required to explain the resolution or reason for closure. Provide a non-empty comment.');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Missing or empty comment');
      expect(mockIssue.closeIssue).not.toHaveBeenCalled();
    });

    it('should reject whitespace-only comment', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'completed',
        comment: '   ',
      });

      expect(result).toBe('Error: comment is required to explain the resolution or reason for closure. Provide a non-empty comment.');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Missing or empty comment');
      expect(mockIssue.closeIssue).not.toHaveBeenCalled();
    });

    it('should reject non-string comment', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'completed',
        comment: 42,
      });

      expect(result).toBe('Error: comment is required to explain the resolution or reason for closure. Provide a non-empty comment.');
      expect(ctx.core.brief).toHaveBeenCalledWith('error', 'issue_close', 'Missing or empty comment');
      expect(mockIssue.closeIssue).not.toHaveBeenCalled();
    });

    // ========== State Transition Tests ==========

    it('should allow closing an in_progress issue', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createInProgressIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 1,
        status: 'completed',
        comment: 'Done',
      });

      expect(mockIssue.closeIssue).toHaveBeenCalled();
      expect(result).toBe('No issues.');
    });

    it('should allow closing a pending issue', async () => {
      mockIssue.getIssue = vi.fn().mockResolvedValue(createPendingIssue());

      const result = await issueCloseTool.handler(ctx, {
        id: 2,
        status: 'failed',
        comment: 'Could not reproduce',
      });

      expect(mockIssue.closeIssue).toHaveBeenCalled();
      expect(result).toBe('No issues.');
    });

    // ========== Blockage Unblocking Tests ==========

    it('should close issue that blocks others (verifies blockage removal)', async () => {
      const blockingIssue = createBlockingIssue();
      mockIssue.getIssue = vi.fn().mockResolvedValue(blockingIssue);

      const result = await issueCloseTool.handler(ctx, {
        id: 3,
        status: 'completed',
        comment: 'Blocker resolved',
      });

      // The handler calls closeIssue which should handle blockage removal
      expect(mockIssue.closeIssue).toHaveBeenCalledWith(3, 'completed', 'Blocker resolved', undefined);
      expect(result).toBe('No issues.');
    });

    // ========== Tool Metadata Tests ==========

    it('should have status enum defined', () => {
      const statusProp = issueCloseTool.input_schema.properties?.status as { enum?: string[] };
      expect(statusProp.enum).toEqual(['completed', 'failed', 'abandoned']);
    });
  });
});

describe('issue-comment', () => {
  /**
   * issue-comment.test.ts - Tests for the issue_comment tool
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
      // Spread rather than passing `issue:` so ctx.issue stays aliased to
      // mockIssue — several tests replace a method on mockIssue after setup.
      ctx = { ...createMockContext({ workdir: '/tmp/test' }), issue: mockIssue };
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

  });
});

describe('issue-publish', () => {
  /**
   * issue-publish.test.ts - Tests for the issue_publish tool
   *
   * issue_publish transitions an issue from 'draft' to 'pending', making it
   * visible to idle teammates for auto-claim.
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
      // Spread rather than passing `issue:` so ctx.issue stays aliased to
      // mockIssue — several tests replace a method on mockIssue after setup.
      ctx = { ...createMockContext({ workdir: '/tmp/test' }), issue: mockIssue };
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

    it('should have only id property', () => {
      const props = issuePublishTool.input_schema.properties;
      expect(props).toHaveProperty('id');
      expect(Object.keys(props || {})).toHaveLength(1);
    });
  });
});
