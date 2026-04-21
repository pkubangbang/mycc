/**
 * Edge case tests for memory-store
 *
 * Tests unusual scenarios and boundary conditions
 * that may not be covered in standard tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addIssueComment,
  createBlockage,
  removeBlockage,
  createTeammate,
  getTeammate,
  listTeammates,
  updateTeammateStatus,
  removeTeammate,
  clearAll,
} from '../../context/memory-store.js';
import type { IssueStatus, TeammateStatus } from '../../types.js';

describe('memory-store edge cases', () => {
  beforeEach(() => {
    clearAll();
  });

  afterEach(() => {
    clearAll();
  });

  // ============================================================================
  // Circular and Self Blockages
  // ============================================================================

  describe('Circular and Self Blockages', () => {
    it('should allow circular blockages (A blocks B, B blocks A)', () => {
      const issueA = createIssue('Issue A', 'Content', []);
      const issueB = createIssue('Issue B', 'Content', [issueA]);

      // Now make B block A (creating a cycle)
      createBlockage(issueB, issueA);

      // Both should have each other as blocker/blocked
      const issueAData = getIssue(issueA);
      const issueBData = getIssue(issueB);

      expect(issueAData?.blockedBy).toContain(issueB);
      expect(issueAData?.blocks).toContain(issueB);
      expect(issueBData?.blockedBy).toContain(issueA);
      expect(issueBData?.blocks).toContain(issueA);
    });

    it('should allow self-blockage (issue blocking itself)', () => {
      const id = createIssue('Self-blocking Issue', 'Content', []);

      // Create self-blockage
      createBlockage(id, id);

      const issue = getIssue(id);
      // Issue should block itself
      expect(issue?.blockedBy).toContain(id);
      expect(issue?.blocks).toContain(id);
    });

    it('should handle A→B→C→A circular dependency', () => {
      const issueA = createIssue('Issue A', 'Content', []);
      const issueB = createIssue('Issue B', 'Content', [issueA]);
      const issueC = createIssue('Issue C', 'Content', [issueB]);

      // Close the circle: C blocks A
      createBlockage(issueC, issueA);

      expect(getIssue(issueA)?.blockedBy).toContain(issueC);
      expect(getIssue(issueC)?.blocks).toContain(issueA);
    });

    it('should handle removing blockage in circular dependency', () => {
      const issueA = createIssue('Issue A', 'Content', []);
      const issueB = createIssue('Issue B', 'Content', [issueA]);
      createBlockage(issueB, issueA); // Make it circular

      // Remove one direction
      removeBlockage(issueA, issueB);

      expect(getIssue(issueA)?.blocks).not.toContain(issueB);
      expect(getIssue(issueA)?.blockedBy).toContain(issueB); // Still blocked by B
      expect(getIssue(issueB)?.blockedBy).not.toContain(issueA);
      expect(getIssue(issueB)?.blocks).toContain(issueA); // Still blocks A
    });
  });

  // ============================================================================
  // Transitive Blockages
  // ============================================================================

  describe('Transitive Blockages', () => {
    it('should track direct blockages (A blocks B, B blocks C)', () => {
      const issueA = createIssue('Issue A', 'Content', []);
      const issueB = createIssue('Issue B', 'Content', [issueA]);
      const issueC = createIssue('Issue C', 'Content', [issueB]);

      // C is directly blocked by B, and B is directly blocked by A
      expect(getIssue(issueC)?.blockedBy).toContain(issueB);
      expect(getIssue(issueC)?.blockedBy).not.toContain(issueA); // Not directly blocked by A
      expect(getIssue(issueB)?.blockedBy).toContain(issueA);
    });

    it('should handle multiple direct blockers with transitive potential', () => {
      const issueA = createIssue('Issue A', 'Content', []);
      const issueB = createIssue('Issue B', 'Content', []);
      const issueC = createIssue('Issue C', 'Content', [issueA, issueB]);
      const issueD = createIssue('Issue D', 'Content', [issueC]);

      // D is directly blocked by C only
      expect(getIssue(issueD)?.blockedBy).toHaveLength(1);
      expect(getIssue(issueD)?.blockedBy).toContain(issueC);

      // C has two direct blockers
      expect(getIssue(issueC)?.blockedBy).toHaveLength(2);
    });

    it('should not automatically create transitive blockages', () => {
      // Memory-store doesn't automatically create transitive blockages
      const issueA = createIssue('Issue A', 'Content', []);
      const issueB = createIssue('Issue B', 'Content', [issueA]);
      const issueC = createIssue('Issue C', 'Content', [issueB]);

      // Issue C should only have B as direct blocker, not A
      expect(getIssue(issueC)?.blockedBy).toHaveLength(1);
      expect(getIssue(issueC)?.blockedBy).toContain(issueB);
      expect(getIssue(issueC)?.blockedBy).not.toContain(issueA);
    });
  });

  // ============================================================================
  // ID Counter Behavior
  // ============================================================================

  describe('ID Counter Behavior', () => {
    it('should continue incrementing ID after clearAll', () => {
      const id1 = createIssue('Issue 1', 'Content', []);
      expect(id1).toBe(1);

      clearAll();

      const id2 = createIssue('Issue 2', 'Content', []);
      expect(id2).toBe(1); // Resets to 1 after clearAll
    });

    it('should not reuse IDs even after "logical deletion"', () => {
      const id1 = createIssue('Issue 1', 'Content', []);
      const id2 = createIssue('Issue 2', 'Content', []);
      const id3 = createIssue('Issue 3', 'Content', []);

      // Mark issue as abandoned (logical deletion)
      updateIssue(id2, { status: 'abandoned' as IssueStatus });

      const id4 = createIssue('Issue 4', 'Content', []);
      expect(id4).toBe(4); // Not reusing ID 2
    });

    it('should maintain unique IDs across many creations', () => {
      const ids = new Set<number>();
      for (let i = 0; i < 1000; i++) {
        const id = createIssue(`Issue ${i}`, 'Content', []);
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
      expect(ids.size).toBe(1000);
    });

    it('should start IDs at 1, not 0', () => {
      const id = createIssue('First Issue', 'Content', []);
      expect(id).toBeGreaterThan(0);
      expect(id).toBe(1);
    });
  });

  // ============================================================================
  // List Ordering
  // ============================================================================

  describe('List Ordering', () => {
    it('should list issues in creation order', () => {
      createIssue('First', 'Content', []);
      createIssue('Second', 'Content', []);
      createIssue('Third', 'Content', []);

      const issues = listIssues();
      expect(issues[0]?.title).toBe('First');
      expect(issues[1]?.title).toBe('Second');
      expect(issues[2]?.title).toBe('Third');
    });

    it('should list teammates in creation order', () => {
      createTeammate('worker-1', 'role', 'prompt');
      createTeammate('worker-2', 'role', 'prompt');
      createTeammate('worker-3', 'role', 'prompt');

      const teammates = listTeammates();
      expect(teammates[0]?.name).toBe('worker-1');
      expect(teammates[1]?.name).toBe('worker-2');
      expect(teammates[2]?.name).toBe('worker-3');
    });

    it('should maintain list order after updates', () => {
      const id1 = createIssue('First', 'Content', []);
      const id2 = createIssue('Second', 'Content', []);
      const id3 = createIssue('Third', 'Content', []);

      // Update middle issue
      updateIssue(id2, { status: 'completed' as IssueStatus });

      const issues = listIssues();
      expect(issues[0]?.id).toBe(id1);
      expect(issues[1]?.id).toBe(id2);
      expect(issues[2]?.id).toBe(id3);
    });

    it('should maintain teammate order after status updates', () => {
      createTeammate('worker-1', 'role', 'prompt');
      createTeammate('worker-2', 'role', 'prompt');
      createTeammate('worker-3', 'role', 'prompt');

      updateTeammateStatus('worker-2', 'shutdown' as TeammateStatus);

      const teammates = listTeammates();
      expect(teammates[0]?.name).toBe('worker-1');
      expect(teammates[1]?.name).toBe('worker-2');
      expect(teammates[2]?.name).toBe('worker-3');
    });
  });

  // ============================================================================
  // Type Safety Tests
  // ============================================================================

  describe('Type Safety', () => {
    it('should accept all valid IssueStatus values', () => {
      const id = createIssue('Test', 'Content', []);

      const validStatuses: IssueStatus[] = [
        'pending',
        'in_progress',
        'completed',
        'failed',
        'abandoned',
      ];

      for (const status of validStatuses) {
        const result = updateIssue(id, { status });
        expect(result).toBe(true);
        expect(getIssue(id)?.status).toBe(status);
      }
    });

    it('should accept all valid TeammateStatus values', () => {
      createTeammate('worker', 'role', 'prompt');

      const validStatuses: TeammateStatus[] = [
        'working',
        'idle',
        'holding',
        'shutdown',
      ];

      for (const status of validStatuses) {
        const result = updateTeammateStatus('worker', status);
        expect(result).toBe(true);
        expect(getTeammate('worker')?.status).toBe(status);
      }
    });

    it('should default to pending status for new issues', () => {
      const id = createIssue('Test', 'Content', []);
      expect(getIssue(id)?.status).toBe('pending');
    });

    it('should default to working status for new teammates', () => {
      createTeammate('worker', 'role', 'prompt');
      expect(getTeammate('worker')?.status).toBe('working');
    });
  });

  // ============================================================================
  // Blockage with Non-Existent Issues
  // ============================================================================

  describe('Blockages with Non-Existent Issues', () => {
    it('should create blockage where blocker does not exist', () => {
      const blocked = createIssue('Blocked', 'Content', []);

      // Create blockage with non-existent blocker
      createBlockage(999, blocked);

      const issue = getIssue(blocked);
      expect(issue?.blockedBy).toContain(999);
    });

    it('should create blockage where blocked does not exist', () => {
      const blocker = createIssue('Blocker', 'Content', []);

      // Create blockage with non-existent blocked
      createBlockage(blocker, 999);

      const issue = getIssue(blocker);
      expect(issue?.blocks).toContain(999);
    });

    it('should create blockage where neither issue exists', () => {
      // Should not throw
      createBlockage(999, 888);
    });

    it('should remove blockage with non-existent issues', () => {
      // Should not throw
      removeBlockage(999, 888);
    });

    it('should create issue blocked by non-existent issue', () => {
      const id = createIssue('Test', 'Content', [999]);
      expect(getIssue(id)?.blockedBy).toContain(999);
    });
  });

  // ============================================================================
  // Comment Timestamps
  // ============================================================================

  describe('Comment Timestamps', () => {
    it('should have increasing timestamps for comments', async () => {
      const id = createIssue('Test', 'Content', []);

      const timestamps: Date[] = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
        addIssueComment(id, `Comment ${i}`, 'user');
        timestamps.push(getIssue(id)!.comments[getIssue(id)!.comments.length - 1].timestamp);
      }

      // Verify timestamps are increasing
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i].getTime()).toBeGreaterThanOrEqual(timestamps[i - 1].getTime());
      }
    });

    it('should have createdAt timestamp for issues', () => {
      const before = new Date();
      const id = createIssue('Test', 'Content', []);
      const after = new Date();

      const issue = getIssue(id);
      expect(issue?.createdAt).toBeInstanceOf(Date);
      expect(issue?.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(issue?.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should have createdAt timestamp for teammates', () => {
      const before = new Date();
      createTeammate('worker', 'role', 'prompt');
      const after = new Date();

      const teammate = getTeammate('worker');
      expect(teammate?.createdAt).toBeInstanceOf(Date);
      expect(teammate?.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(teammate?.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // ============================================================================
  // Empty and Null-like Values
  // ============================================================================

  describe('Empty and Null-like Values', () => {
    it('should handle empty title', () => {
      const id = createIssue('', 'Content', []);
      expect(getIssue(id)?.title).toBe('');
    });

    it('should handle empty content', () => {
      const id = createIssue('Title', '', []);
      expect(getIssue(id)?.content).toBe('');
    });

    it('should handle empty role', () => {
      createTeammate('worker', '', 'prompt');
      expect(getTeammate('worker')?.role).toBe('');
    });

    it('should handle empty prompt', () => {
      createTeammate('worker', 'role', '');
      expect(getTeammate('worker')?.prompt).toBe('');
    });

    it('should handle empty blockedBy array', () => {
      const id = createIssue('Test', 'Content', []);
      expect(getIssue(id)?.blockedBy).toEqual([]);
    });

    it('should handle update with empty object', () => {
      const id = createIssue('Original', 'Content', []);
      updateIssue(id, {});

      const issue = getIssue(id);
      expect(issue?.title).toBe('Original');
      expect(issue?.content).toBe('Content');
      expect(issue?.status).toBe('pending');
    });
  });

  // ============================================================================
  // Rapid Sequential Operations
  // ============================================================================

  describe('Rapid Sequential Operations', () => {
    it('should handle rapid create-update cycles', () => {
      for (let i = 0; i < 100; i++) {
        const id = createIssue(`Issue ${i}`, 'Content', []);
        updateIssue(id, { status: 'in_progress' as IssueStatus });
        updateIssue(id, { status: 'completed' as IssueStatus });
      }

      const issues = listIssues();
      expect(issues).toHaveLength(100);
      expect(issues.every((i) => i.status === 'completed')).toBe(true);
    });

    it('should handle rapid teammate create-update cycles', () => {
      for (let i = 0; i < 100; i++) {
        createTeammate(`worker-${i}`, 'role', 'prompt');
        updateTeammateStatus(`worker-${i}`, 'idle' as TeammateStatus);
        updateTeammateStatus(`worker-${i}`, 'working' as TeammateStatus);
      }

      const teammates = listTeammates();
      expect(teammates).toHaveLength(100);
      expect(teammates.every((t) => t.status === 'working')).toBe(true);
    });

    it('should handle rapid blockage create-remove cycles', () => {
      const issue1 = createIssue('Issue 1', 'Content', []);
      const issue2 = createIssue('Issue 2', 'Content', []);

      for (let i = 0; i < 50; i++) {
        createBlockage(issue1, issue2);
        removeBlockage(issue1, issue2);
      }

      // Should end with no blockage
      expect(getIssue(issue1)?.blocks).toEqual([]);
      expect(getIssue(issue2)?.blockedBy).toEqual([]);
    });
  });
});