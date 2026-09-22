/**
 * Integration tests for memory-store
 *
 * Tests complex scenarios combining multiple operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addIssueComment,
  createBlockage,
  createTeammate,
  getTeammate,
  listTeammates,
  updateTeammateStatus,
  removeTeammate,
  clearAll,
} from '../../context/memory-store.js';
import type { IssueStatus, TeammateStatus } from '../../types.js';

describe('memory-store integration tests', () => {
  beforeEach(() => {
    clearAll();
  });

  afterEach(() => {
    clearAll();
  });

  // ============================================================================
  // Cross-Entity Integration
  // ============================================================================

  describe('Cross-Entity Operations', () => {
    it('should maintain separate stores for issues and teammates', () => {
      createIssue('Issue 1', 'Content', []);
      createIssue('Issue 2', 'Content', []);
      createTeammate('worker-1', 'developer', 'Write code');
      createTeammate('worker-2', 'tester', 'Test code');

      expect(listIssues()).toHaveLength(2);
      expect(listTeammates()).toHaveLength(2);
    });

    it('should clear all entities with clearAll', () => {
      createIssue('Issue', 'Content', []);
      createTeammate('worker', 'developer', 'Write code');
      createBlockage(1, 2);

      clearAll();

      expect(listIssues()).toEqual([]);
      expect(listTeammates()).toEqual([]);
      expect(getIssue(1)).toBeUndefined();
      expect(getTeammate('worker')).toBeUndefined();
    });

  });

  // ============================================================================
  // Complex Issue Scenarios
  // ============================================================================

  describe('Complex Issue Scenarios', () => {
    it('should handle issue lifecycle with comments', () => {
      const id = createIssue('Lifecycle Issue', 'Start content', []);

      // Add multiple comments
      addIssueComment(id, 'First update', 'agent-1');
      addIssueComment(id, 'Second update', 'agent-2');
      addIssueComment(id, 'Final update', 'system');

      // Update through statuses
      updateIssue(id, { status: 'in_progress' as IssueStatus, owner: 'agent-1' });
      updateIssue(id, { status: 'completed' as IssueStatus });

      const issue = getIssue(id);
      expect(issue?.status).toBe('completed');
      expect(issue?.owner).toBe('agent-1');
      expect(issue?.comments).toHaveLength(4); // 1 system + 3 added
    });



  });

  // ============================================================================
  // Complex Blockage Scenarios
  // ============================================================================

  // (Complex Blockage Scenarios tests retired — blockage coverage lives in edge-cases.test.ts)

  // ============================================================================
  // Teammate Lifecycle Tests
  // ============================================================================

  describe('Teammate Lifecycle', () => {
    it('should handle complete teammate lifecycle', () => {
      // Create
      createTeammate('worker', 'developer', 'Write code');
      expect(getTeammate('worker')?.status).toBe('working');

      // Update status multiple times
      updateTeammateStatus('worker', 'idle' as TeammateStatus);
      expect(getTeammate('worker')?.status).toBe('idle');

      updateTeammateStatus('worker', 'holding' as TeammateStatus);
      expect(getTeammate('worker')?.status).toBe('holding');

      updateTeammateStatus('worker', 'working' as TeammateStatus);
      expect(getTeammate('worker')?.status).toBe('working');

      // Remove
      const removed = removeTeammate('worker');
      expect(removed).toBe(true);
      expect(getTeammate('worker')).toBeUndefined();
    });


    it('should preserve createdAt on status updates', () => {
      createTeammate('worker', 'developer', 'Write code');
      const originalCreatedAt = getTeammate('worker')?.createdAt;

      updateTeammateStatus('worker', 'idle' as TeammateStatus);

      expect(getTeammate('worker')?.createdAt).toEqual(originalCreatedAt);
    });

  });

  // ============================================================================
  // Data Consistency Tests
  // ============================================================================

  describe('Data Consistency', () => {



    it('should preserve issue relationships after updates', () => {
      const issue1 = createIssue('Issue 1', 'Content', []);
      const issue2 = createIssue('Issue 2', 'Content', [issue1]);

      // Update issue1
      updateIssue(issue1, { title: 'Updated Title', status: 'completed' as IssueStatus });
      updateIssue(issue1, { content: 'Updated content' });

      // Relationships should still exist
      expect(getIssue(issue1)?.blocks).toContain(issue2);
      expect(getIssue(issue2)?.blockedBy).toContain(issue1);
    });

  });

  // ============================================================================
  // Edge Cases and Boundary Conditions
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle unicode in issue content', () => {
      const id = createIssue('日本語タイトル', '内容 🎉 emoji', []);
      const issue = getIssue(id);

      expect(issue?.title).toBe('日本語タイトル');
      expect(issue?.content).toBe('内容 🎉 emoji');
    });







  });

  // ============================================================================
  // Stress Tests
  // ============================================================================

  // (stress tests retired)
});
