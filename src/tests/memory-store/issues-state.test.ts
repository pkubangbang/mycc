/**
 * Tests for Issue state management
 *
 * Includes:
 * - ID generation uniqueness
 * - Issue status transitions
 * - Issue-related edge cases
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
  // ID Generation Uniqueness
  // ============================================================================

  describe('ID Generation Uniqueness', () => {
    it('should generate unique IDs across multiple creations', () => {
      const ids = new Set<number>();

      for (let i = 0; i < 100; i++) {
        const id = createIssue(`Issue ${i}`, 'Content', []);
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }

      expect(ids.size).toBe(100);
    });

    it('should reset ID counter after clearAll', () => {
      createIssue('Issue 1', 'Content', []);
      createIssue('Issue 2', 'Content', []);

      clearAll();

      const newId = createIssue('New Issue', 'Content', []);
      expect(newId).toBe(1);
    });

    it('should continue ID sequence after removal', () => {
      const id1 = createIssue('Issue 1', 'Content', []);
      const id2 = createIssue('Issue 2', 'Content', []);

      // Remove first issue
      updateIssue(id1, { status: 'completed' as IssueStatus });

      const id3 = createIssue('Issue 3', 'Content', []);
      expect(id3).toBe(3);
    });
  });

  // ============================================================================
  // Issue State Transitions
  // ============================================================================

  describe('Issue State Transitions', () => {
    it('should transition from pending to in_progress', () => {
      const id = createIssue('Test', 'Content', []);

      updateIssue(id, { status: 'in_progress' as IssueStatus });

      expect(getIssue(id)?.status).toBe('in_progress');
    });

    it('should transition from in_progress to completed', () => {
      const id = createIssue('Test', 'Content', []);

      updateIssue(id, { status: 'in_progress' as IssueStatus });
      updateIssue(id, { status: 'completed' as IssueStatus });

      expect(getIssue(id)?.status).toBe('completed');
    });

    it('should transition from in_progress to failed', () => {
      const id = createIssue('Test', 'Content', []);

      updateIssue(id, { status: 'in_progress' as IssueStatus });
      updateIssue(id, { status: 'failed' as IssueStatus });

      expect(getIssue(id)?.status).toBe('failed');
    });

    it('should transition from in_progress to abandoned', () => {
      const id = createIssue('Test', 'Content', []);

      updateIssue(id, { status: 'in_progress' as IssueStatus });
      updateIssue(id, { status: 'abandoned' as IssueStatus });

      expect(getIssue(id)?.status).toBe('abandoned');
    });

    it('should allow direct transition to any status', () => {
      const id = createIssue('Test', 'Content', []);

      // No validation on transitions, can go to any status
      updateIssue(id, { status: 'completed' as IssueStatus });
      expect(getIssue(id)?.status).toBe('completed');
    });
  });

  // ============================================================================
  // Issue Edge Cases
  // ============================================================================

  describe('Issue Edge Cases', () => {
    describe('Non-existent entities', () => {
      it('should handle getIssue for non-existent ID', () => {
        expect(getIssue(999)).toBeUndefined();
      });

      it('should handle updateIssue for non-existent ID', () => {
        expect(updateIssue(999, { title: 'New' })).toBe(false);
      });

      it('should handle addIssueComment for non-existent ID', () => {
        expect(addIssueComment(999, 'Comment', 'user')).toBe(false);
      });
    });

    describe('Empty state', () => {
      it('should list empty issues', () => {
        expect(listIssues()).toEqual([]);
      });

      it('should handle clearAll when already empty', () => {
        // Should not throw
        clearAll();
        clearAll();
      });
    });

    describe('Special characters and boundaries', () => {
      it('should handle issue with empty title', () => {
        const id = createIssue('', 'Content', []);
        expect(getIssue(id)?.title).toBe('');
      });

      it('should handle issue with empty content', () => {
        const id = createIssue('Title', '', []);
        expect(getIssue(id)?.content).toBe('');
      });

      it('should handle long strings', () => {
        const longTitle = 'a'.repeat(10000);
        const id = createIssue(longTitle, 'Content', []);
        expect(getIssue(id)?.title).toBe(longTitle);
      });
    });
  });
});