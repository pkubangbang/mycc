/**
 * format-issue.test.ts - Tests for shared issue formatting utilities
 */

import { describe, it, expect } from 'vitest';
import { formatIssueList, formatIssueDetail } from '../../context/shared/format-issue.js';
import type { Issue } from '../../types.js';

describe('formatIssueList', () => {
  it('should return "No issues." for empty array', () => {
    expect(formatIssueList([])).toBe('No issues.');
  });

  it('should format a single issue', () => {
    const issues: Issue[] = [
      {
        id: 1,
        title: 'Test Issue',
        content: 'Test content',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        comments: [],
        createdAt: new Date('2024-01-01'),
      },
    ];

    const result = formatIssueList(issues);
    expect(result).toContain('Issues:');
    expect(result).toContain('#1: Test Issue');
    expect(result).toContain('[ ]');
  });

  it('should format issue with owner', () => {
    const issues: Issue[] = [
      {
        id: 2,
        title: 'Owned Issue',
        content: 'Content',
        status: 'in_progress',
        owner: 'agent-1',
        blockedBy: [],
        blocks: [],
        comments: [],
        createdAt: new Date(),
      },
    ];

    const result = formatIssueList(issues);
    expect(result).toContain('@agent-1');
    expect(result).toContain('[>]');
  });

  it('should format issue with blockedBy', () => {
    const issues: Issue[] = [
      {
        id: 3,
        title: 'Blocked Issue',
        content: 'Content',
        status: 'pending',
        blockedBy: [1, 2],
        blocks: [],
        comments: [],
        createdAt: new Date(),
      },
    ];

    const result = formatIssueList(issues);
    expect(result).toContain('blocked:1,2');
  });

  it('should format multiple issues', () => {
    const issues: Issue[] = [
      {
        id: 1,
        title: 'First',
        content: '',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        comments: [],
        createdAt: new Date(),
      },
      {
        id: 2,
        title: 'Second',
        content: '',
        status: 'completed',
        blockedBy: [],
        blocks: [],
        comments: [],
        createdAt: new Date(),
      },
    ];

    const result = formatIssueList(issues);
    expect(result).toContain('#1: First');
    expect(result).toContain('#2: Second');
    expect(result).toContain('[ ]');
    expect(result).toContain('[x]');
  });

  it('should handle all status types', () => {
    const statuses: Array<Issue['status']> = ['pending', 'in_progress', 'completed', 'failed', 'abandoned'];
    const markers = ['[ ]', '[>]', '[x]', '[!]', '[-]'];

    statuses.forEach((status, index) => {
      const issues: Issue[] = [
        {
          id: index + 1,
          title: `Issue ${status}`,
          content: '',
          status,
          blockedBy: [],
          blocks: [],
          comments: [],
          createdAt: new Date(),
        },
      ];

      const result = formatIssueList(issues);
      expect(result).toContain(markers[index]);
    });
  });
});

describe('formatIssueDetail', () => {
  it('should format a minimal issue', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: 'Content',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('Issue #1: Test');
    expect(result).toContain('Status: [ ]');
  });

  it('should format issue with owner', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: 'Content',
      status: 'in_progress',
      owner: 'agent-1',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('Owner: @agent-1');
  });

  it('should format issue with content', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: 'This is the content',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('Content:');
    expect(result).toContain('This is the content');
  });

  it('should format issue with blockedBy', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: '',
      status: 'pending',
      blockedBy: [2, 3, 4],
      blocks: [],
      comments: [],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('Blocked by: 2, 3, 4');
  });

  it('should format issue with blocks', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: '',
      status: 'pending',
      blockedBy: [],
      blocks: [5, 6],
      comments: [],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('Blocks: 5, 6');
  });

  it('should format issue with comments', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: '',
      status: 'pending',
      owner: 'agent-1',
      blockedBy: [],
      blocks: [],
      comments: [
        { poster: 'system', content: 'Created', timestamp: new Date() },
        { poster: 'agent-2', content: 'Looking at this', timestamp: new Date() },
      ],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('Comments:');
    expect(result).toContain('system: Created');
    expect(result).toContain('> @agent-2: Looking at this');
  });

  it('should use < prefix for owner comments', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: '',
      status: 'pending',
      owner: 'agent-1',
      blockedBy: [],
      blocks: [],
      comments: [{ poster: 'agent-1', content: 'My comment', timestamp: new Date() }],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('< @agent-1: My comment');
  });

  it('should use > prefix for non-owner comments', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: '',
      status: 'pending',
      owner: 'agent-1',
      blockedBy: [],
      blocks: [],
      comments: [{ poster: 'agent-2', content: 'Comment', timestamp: new Date() }],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('> @agent-2: Comment');
  });

  it('should format system comments without @', () => {
    const issue: Issue = {
      id: 1,
      title: 'Test',
      content: '',
      status: 'pending',
      blockedBy: [],
      blocks: [],
      comments: [{ poster: 'system', content: 'Auto-generated', timestamp: new Date() }],
      createdAt: new Date(),
    };

    const result = formatIssueDetail(issue);
    expect(result).toContain('> system: Auto-generated');
  });

  it('should handle all status types', () => {
    const statuses: Array<Issue['status']> = ['pending', 'in_progress', 'completed', 'failed', 'abandoned'];
    const markers = ['[ ]', '[>]', '[x]', '[!]', '[-]'];

    statuses.forEach((status, index) => {
      const issue: Issue = {
        id: 1,
        title: 'Test',
        content: '',
        status,
        blockedBy: [],
        blocks: [],
        comments: [],
        createdAt: new Date(),
      };

      const result = formatIssueDetail(issue);
      expect(result).toContain(`Status: ${markers[index]}`);
    });
  });
});
