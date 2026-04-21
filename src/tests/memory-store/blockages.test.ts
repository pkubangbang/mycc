/**
 * Tests for Blockage relationships
 *
 * Includes:
 * - createBlockage, removeBlockage
 * - Blockage edge cases (chains, diamond patterns)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createIssue,
  getIssue,
  createBlockage,
  removeBlockage,
  clearAll,
} from '../../context/memory-store.js';

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
  // Blockage Relationships
  // ============================================================================

  describe('Blockage Operations', () => {
    describe('createBlockage', () => {
      it('should create blockage between two issues', () => {
        const blockerId = createIssue('Blocker', 'Content', []);
        const blockedId = createIssue('Blocked', 'Content', []);

        createBlockage(blockerId, blockedId);

        const blocker = getIssue(blockerId);
        const blocked = getIssue(blockedId);

        expect(blocker?.blocks).toContain(blockedId);
        expect(blocked?.blockedBy).toContain(blockerId);
      });

      it('should not duplicate blockages', () => {
        const blockerId = createIssue('Blocker', 'Content', []);
        const blockedId = createIssue('Blocked', 'Content', []);

        createBlockage(blockerId, blockedId);
        createBlockage(blockerId, blockedId); // Create again

        const blocker = getIssue(blockerId);
        expect(blocker?.blocks).toHaveLength(1);
      });

      it('should create multiple blockages from same blocker', () => {
        const blockerId = createIssue('Blocker', 'Content', []);
        const blocked1 = createIssue('Blocked 1', 'Content', []);
        const blocked2 = createIssue('Blocked 2', 'Content', []);

        createBlockage(blockerId, blocked1);
        createBlockage(blockerId, blocked2);

        const blocker = getIssue(blockerId);
        expect(blocker?.blocks).toHaveLength(2);
        expect(blocker?.blocks).toContain(blocked1);
        expect(blocker?.blocks).toContain(blocked2);
      });

      it('should create multiple blockages to same blocked issue', () => {
        const blocker1 = createIssue('Blocker 1', 'Content', []);
        const blocker2 = createIssue('Blocker 2', 'Content', []);
        const blockedId = createIssue('Blocked', 'Content', []);

        createBlockage(blocker1, blockedId);
        createBlockage(blocker2, blockedId);

        const blocked = getIssue(blockedId);
        expect(blocked?.blockedBy).toHaveLength(2);
        expect(blocked?.blockedBy).toContain(blocker1);
        expect(blocked?.blockedBy).toContain(blocker2);
      });

      it('should handle non-existent blocker issue', () => {
        const blockedId = createIssue('Blocked', 'Content', []);

        // Should not throw
        createBlockage(999, blockedId);

        const blocked = getIssue(blockedId);
        expect(blocked?.blockedBy).toContain(999);
      });

      it('should handle non-existent blocked issue', () => {
        const blockerId = createIssue('Blocker', 'Content', []);

        // Should not throw
        createBlockage(blockerId, 999);

        const blocker = getIssue(blockerId);
        expect(blocker?.blocks).toContain(999);
      });
    });

    describe('removeBlockage', () => {
      it('should remove existing blockage', () => {
        const blockerId = createIssue('Blocker', 'Content', []);
        const blockedId = createIssue('Blocked', 'Content', [blockerId]);

        removeBlockage(blockerId, blockedId);

        const blocker = getIssue(blockerId);
        const blocked = getIssue(blockedId);

        expect(blocker?.blocks).not.toContain(blockedId);
        expect(blocked?.blockedBy).not.toContain(blockerId);
      });

      it('should handle removing non-existent blockage', () => {
        const id = createIssue('Test', 'Content', []);

        // Should not throw
        removeBlockage(id, 999);
        removeBlockage(999, id);
        removeBlockage(999, 888);
      });

      it('should update issue relationships after removal', () => {
        const blockerId = createIssue('Blocker', 'Content', []);
        const blockedId = createIssue('Blocked', 'Content', [blockerId]);

        expect(getIssue(blockerId)?.blocks).toContain(blockedId);
        expect(getIssue(blockedId)?.blockedBy).toContain(blockerId);

        removeBlockage(blockerId, blockedId);

        expect(getIssue(blockerId)?.blocks).toEqual([]);
        expect(getIssue(blockedId)?.blockedBy).toEqual([]);
      });

      it('should only remove specified blockage', () => {
        const blocker1 = createIssue('Blocker 1', 'Content', []);
        const blocker2 = createIssue('Blocker 2', 'Content', []);
        const blockedId = createIssue('Blocked', 'Content', []);

        createBlockage(blocker1, blockedId);
        createBlockage(blocker2, blockedId);

        removeBlockage(blocker1, blockedId);

        const blocked = getIssue(blockedId);
        expect(blocked?.blockedBy).toHaveLength(1);
        expect(blocked?.blockedBy).toContain(blocker2);
      });
    });
  });

  // ============================================================================
  // Blockage Edge Cases
  // ============================================================================

  describe('Blockage Edge Cases', () => {
    describe('Duplicate handling', () => {
      it('should handle duplicate blockage creation', () => {
        const blocker = createIssue('Blocker', 'Content', []);
        const blocked = createIssue('Blocked', 'Content', []);

        createBlockage(blocker, blocked);
        createBlockage(blocker, blocked);

        expect(getIssue(blocker)?.blocks).toHaveLength(1);
        expect(getIssue(blocked)?.blockedBy).toHaveLength(1);
      });
    });

    describe('Non-existent entities', () => {
      it('should handle createBlockage with non-existent issues', () => {
        // Should not throw
        createBlockage(999, 888);
      });

      it('should handle removeBlockage with non-existent issues', () => {
        // Should not throw
        removeBlockage(999, 888);
      });
    });

    describe('Complex scenarios', () => {
      it('should handle chain of blockages', () => {
        const issue1 = createIssue('Issue 1', 'Content', []);
        const issue2 = createIssue('Issue 2', 'Content', [issue1]);
        const issue3 = createIssue('Issue 3', 'Content', [issue2]);

        expect(getIssue(issue1)?.blocks).toContain(issue2);
        expect(getIssue(issue2)?.blockedBy).toContain(issue1);
        expect(getIssue(issue2)?.blocks).toContain(issue3);
        expect(getIssue(issue3)?.blockedBy).toContain(issue2);
      });

      it('should handle diamond dependency pattern', () => {
        const root = createIssue('Root', 'Content', []);
        const left = createIssue('Left', 'Content', [root]);
        const right = createIssue('Right', 'Content', [root]);
        const bottom = createIssue('Bottom', 'Content', [left, right]);

        const rootIssue = getIssue(root);
        expect(rootIssue?.blocks).toHaveLength(2);
        expect(rootIssue?.blocks).toContain(left);
        expect(rootIssue?.blocks).toContain(right);

        const bottomIssue = getIssue(bottom);
        expect(bottomIssue?.blockedBy).toHaveLength(2);
        expect(bottomIssue?.blockedBy).toContain(left);
        expect(bottomIssue?.blockedBy).toContain(right);
      });
    });
  });
});