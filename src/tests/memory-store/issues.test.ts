/**
 * Tests for Issue CRUD operations
 *
 * Includes:
 * - createIssue, getIssue, listIssues, updateIssue, addIssueComment
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addIssueComment,
  clearAll,
} from '../../context/memory-store.js';
import type { IssueStatus } from '../../types.js';

describe('memory-store', () => {
  // Reset state before each test for isolation
  beforeEach(() => {
    clearAll();
  });

  // Also reset after all tests to clean up
  afterEach(() => {
    clearAll();
  });

  // ============================================================================
  // Issue CRUD Operations
  // ============================================================================

  describe('Issue CRUD', () => {
    describe('createIssue', () => {
      it('should create an issue with valid data', () => {
        const id = createIssue('Test Issue', 'Test content', []);

        expect(id).toBe(1);
        const issue = getIssue(id);
        expect(issue).toBeDefined();
        expect(issue?.title).toBe('Test Issue');
        expect(issue?.content).toBe('Test content');
        expect(issue?.status).toBe('pending');
        expect(issue?.blockedBy).toEqual([]);
        expect(issue?.blocks).toEqual([]);
        expect(issue?.comments).toHaveLength(1);
        expect(issue?.comments[0].poster).toBe('system');
        expect(issue?.createdAt).toBeInstanceOf(Date);
      });

      it('should create issues with sequential IDs', () => {
        const id1 = createIssue('First Issue', 'Content 1', []);
        const id2 = createIssue('Second Issue', 'Content 2', []);
        const id3 = createIssue('Third Issue', 'Content 3', []);

        expect(id1).toBe(1);
        expect(id2).toBe(2);
        expect(id3).toBe(3);
      });

      it('should create issue with blockedBy relationships', () => {
        const blockerId = createIssue('Blocker', 'Blocks others', []);
        const blockedId = createIssue('Blocked', 'Is blocked', [blockerId]);

        const blockedIssue = getIssue(blockedId);
        expect(blockedIssue?.blockedBy).toContain(blockerId);

        const blockerIssue = getIssue(blockerId);
        expect(blockerIssue?.blocks).toContain(blockedId);
      });

      it('should create issue with multiple blockedBy relationships', () => {
        const blocker1 = createIssue('Blocker 1', 'First blocker', []);
        const blocker2 = createIssue('Blocker 2', 'Second blocker', []);
        const blocked = createIssue('Blocked', 'Is blocked', [blocker1, blocker2]);

        const blockedIssue = getIssue(blocked);
        expect(blockedIssue?.blockedBy).toHaveLength(2);
        expect(blockedIssue?.blockedBy).toContain(blocker1);
        expect(blockedIssue?.blockedBy).toContain(blocker2);

        expect(getIssue(blocker1)?.blocks).toContain(blocked);
        expect(getIssue(blocker2)?.blocks).toContain(blocked);
      });

      it('should create issue with empty blockedBy array', () => {
        const id = createIssue('Independent', 'No blockers', []);

        const issue = getIssue(id);
        expect(issue?.blockedBy).toEqual([]);
        expect(issue?.blocks).toEqual([]);
      });

      it('should handle non-existent blocker IDs gracefully', () => {
        // Creating an issue with a non-existent blocker ID
        // The blockage should be created in the blockages map
        const id = createIssue('Issue', 'Content', [999]);

        const issue = getIssue(id);
        expect(issue?.blockedBy).toContain(999);
      });
    });

    describe('getIssue', () => {
      it('should return issue by ID', () => {
        const id = createIssue('Test', 'Content', []);
        const issue = getIssue(id);

        expect(issue).toBeDefined();
        expect(issue?.id).toBe(id);
        expect(issue?.title).toBe('Test');
      });

      it('should return undefined for non-existent ID', () => {
        const issue = getIssue(999);
        expect(issue).toBeUndefined();
      });

      it('should return undefined after clearAll', () => {
        const id = createIssue('Test', 'Content', []);
        expect(getIssue(id)).toBeDefined();

        clearAll();

        expect(getIssue(id)).toBeUndefined();
      });
    });

    describe('listIssues', () => {
      it('should return empty array when no issues exist', () => {
        const issues = listIssues();
        expect(issues).toEqual([]);
      });

      it('should return all issues', () => {
        createIssue('Issue 1', 'Content 1', []);
        createIssue('Issue 2', 'Content 2', []);
        createIssue('Issue 3', 'Content 3', []);

        const issues = listIssues();
        expect(issues).toHaveLength(3);
        expect(issues.map((i) => i.title)).toEqual(['Issue 1', 'Issue 2', 'Issue 3']);
      });

      it('should return issues in order of creation', () => {
        createIssue('First', 'Content', []);
        createIssue('Second', 'Content', []);
        createIssue('Third', 'Content', []);

        const issues = listIssues();
        expect(issues[0].id).toBeLessThan(issues[1].id);
        expect(issues[1].id).toBeLessThan(issues[2].id);
      });
    });

    describe('updateIssue', () => {
      it('should update issue title', () => {
        const id = createIssue('Original Title', 'Content', []);

        const result = updateIssue(id, { title: 'Updated Title' });

        expect(result).toBe(true);
        expect(getIssue(id)?.title).toBe('Updated Title');
      });

      it('should update issue status', () => {
        const id = createIssue('Test', 'Content', []);

        const result = updateIssue(id, { status: 'in_progress' as IssueStatus });

        expect(result).toBe(true);
        expect(getIssue(id)?.status).toBe('in_progress');
      });

      it('should update issue content', () => {
        const id = createIssue('Test', 'Original content', []);

        const result = updateIssue(id, { content: 'Updated content' });

        expect(result).toBe(true);
        expect(getIssue(id)?.content).toBe('Updated content');
      });

      it('should update multiple fields at once', () => {
        const id = createIssue('Test', 'Content', []);

        const result = updateIssue(id, {
          title: 'New Title',
          content: 'New Content',
          status: 'completed' as IssueStatus,
          owner: 'test-agent',
        });

        expect(result).toBe(true);
        const issue = getIssue(id);
        expect(issue?.title).toBe('New Title');
        expect(issue?.content).toBe('New Content');
        expect(issue?.status).toBe('completed');
        expect(issue?.owner).toBe('test-agent');
      });

      it('should return false for non-existent issue', () => {
        const result = updateIssue(999, { title: 'New Title' });
        expect(result).toBe(false);
      });

      it('should preserve non-updated fields', () => {
        const id = createIssue('Original', 'Content', []);

        updateIssue(id, { status: 'in_progress' as IssueStatus });

        const issue = getIssue(id);
        expect(issue?.title).toBe('Original');
        expect(issue?.content).toBe('Content');
      });
    });

    describe('addIssueComment', () => {
      it('should add comment to issue', () => {
        const id = createIssue('Test', 'Content', []);

        const result = addIssueComment(id, 'First comment', 'user1');

        expect(result).toBe(true);
        const issue = getIssue(id);
        expect(issue?.comments).toHaveLength(2); // 1 system + 1 added
        expect(issue?.comments[1].poster).toBe('user1');
        expect(issue?.comments[1].content).toBe('First comment');
        expect(issue?.comments[1].timestamp).toBeInstanceOf(Date);
      });

      it('should add multiple comments', () => {
        const id = createIssue('Test', 'Content', []);

        addIssueComment(id, 'Comment 1', 'user1');
        addIssueComment(id, 'Comment 2', 'user2');
        addIssueComment(id, 'Comment 3', 'system');

        const issue = getIssue(id);
        expect(issue?.comments).toHaveLength(4);
      });

      it('should return false for non-existent issue', () => {
        const result = addIssueComment(999, 'Comment', 'user');
        expect(result).toBe(false);
      });
    });
  });
});