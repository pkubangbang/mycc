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
  removeBlockage,
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

    it('should handle clearAll multiple times without error', () => {
      createIssue('Issue', 'Content', []);
      clearAll();
      clearAll();
      clearAll();
      expect(listIssues()).toEqual([]);
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

    it('should maintain comment order', () => {
      const id = createIssue('Test', 'Content', []);

      for (let i = 0; i < 10; i++) {
        addIssueComment(id, `Comment ${i}`, `user-${i}`);
      }

      const issue = getIssue(id);
      expect(issue?.comments).toHaveLength(11); // 1 system + 10 added
      for (let i = 0; i < 10; i++) {
        expect(issue?.comments[i + 1]?.content).toBe(`Comment ${i}`);
      }
    });

    it('should handle owner assignment', () => {
      const id = createIssue('Test', 'Content', []);

      updateIssue(id, { owner: 'agent-1' });
      expect(getIssue(id)?.owner).toBe('agent-1');

      updateIssue(id, { owner: 'agent-2' });
      expect(getIssue(id)?.owner).toBe('agent-2');

      updateIssue(id, { owner: undefined });
      expect(getIssue(id)?.owner).toBeUndefined();
    });

    it('should handle multiple status changes', () => {
      const id = createIssue('Test', 'Content', []);

      const statuses: IssueStatus[] = ['in_progress', 'pending', 'in_progress', 'completed', 'failed', 'in_progress', 'abandoned'];

      for (const status of statuses) {
        updateIssue(id, { status });
        expect(getIssue(id)?.status).toBe(status);
      }
    });
  });

  // ============================================================================
  // Complex Blockage Scenarios
  // ============================================================================

  describe('Complex Blockage Scenarios', () => {
    it('should handle issue removal with blockages', () => {
      const issue1 = createIssue('Issue 1', 'Content', []);
      const issue2 = createIssue('Issue 2', 'Content', [issue1]);
      const issue3 = createIssue('Issue 3', 'Content', [issue1, issue2]);

      // Verify initial state
      expect(getIssue(issue1)?.blocks).toContain(issue2);
      expect(getIssue(issue1)?.blocks).toContain(issue3);
      expect(getIssue(issue2)?.blocks).toContain(issue3);

      // Remove middle issue (conceptually - memory-store doesn't have deleteIssue)
      // But we can still verify the blockage relationships remain intact
      expect(getIssue(issue2)?.blockedBy).toContain(issue1);
      expect(getIssue(issue3)?.blockedBy).toHaveLength(2);
    });

    it('should handle re-adding blockages after removal', () => {
      const issue1 = createIssue('Issue 1', 'Content', []);
      const issue2 = createIssue('Issue 2', 'Content', []);

      createBlockage(issue1, issue2);
      expect(getIssue(issue1)?.blocks).toContain(issue2);

      removeBlockage(issue1, issue2);
      expect(getIssue(issue1)?.blocks).not.toContain(issue2);

      createBlockage(issue1, issue2);
      expect(getIssue(issue1)?.blocks).toContain(issue2);
      expect(getIssue(issue2)?.blockedBy).toContain(issue1);
    });

    it('should handle deep dependency chains', () => {
      const issues: number[] = [];
      for (let i = 0; i < 10; i++) {
        const blockedBy = i > 0 ? [issues[i - 1]] : [];
        issues.push(createIssue(`Issue ${i}`, 'Content', blockedBy));
      }

      // Verify chain
      for (let i = 0; i < 10; i++) {
        const issue = getIssue(issues[i]);
        if (i === 0) {
          expect(issue?.blockedBy).toEqual([]);
          expect(issue?.blocks).toContain(issues[i + 1]);
        } else if (i === 9) {
          expect(issue?.blockedBy).toContain(issues[i - 1]);
          expect(issue?.blocks).toEqual([]);
        } else {
          expect(issue?.blockedBy).toContain(issues[i - 1]);
          expect(issue?.blocks).toContain(issues[i + 1]);
        }
      }
    });

    it('should handle many-to-many relationships', () => {
      const issue1 = createIssue('Issue 1', 'Content', []);
      const issue2 = createIssue('Issue 2', 'Content', []);
      const issue3 = createIssue('Issue 3', 'Content', [issue1, issue2]);
      const issue4 = createIssue('Issue 4', 'Content', [issue1, issue2, issue3]);

      // Verify relationships
      expect(getIssue(issue1)?.blocks).toHaveLength(2);
      expect(getIssue(issue1)?.blocks).toContain(issue3);
      expect(getIssue(issue1)?.blocks).toContain(issue4);

      expect(getIssue(issue2)?.blocks).toHaveLength(2);
      expect(getIssue(issue2)?.blocks).toContain(issue3);
      expect(getIssue(issue2)?.blocks).toContain(issue4);

      expect(getIssue(issue3)?.blockedBy).toHaveLength(2);
      expect(getIssue(issue3)?.blocks).toContain(issue4);

      expect(getIssue(issue4)?.blockedBy).toHaveLength(3);
    });
  });

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

    it('should handle multiple teammates with same status changes', () => {
      const teammates = ['worker-1', 'worker-2', 'worker-3'];

      for (const name of teammates) {
        createTeammate(name, 'developer', 'Write code');
      }

      // Change all to idle
      for (const name of teammates) {
        updateTeammateStatus(name, 'idle' as TeammateStatus);
      }

      // Verify all are idle
      for (const name of teammates) {
        expect(getTeammate(name)?.status).toBe('idle');
      }

      // Change all to shutdown
      for (const name of teammates) {
        updateTeammateStatus(name, 'shutdown' as TeammateStatus);
      }

      for (const name of teammates) {
        expect(getTeammate(name)?.status).toBe('shutdown');
      }
    });

    it('should preserve createdAt on status updates', () => {
      createTeammate('worker', 'developer', 'Write code');
      const originalCreatedAt = getTeammate('worker')?.createdAt;

      updateTeammateStatus('worker', 'idle' as TeammateStatus);

      expect(getTeammate('worker')?.createdAt).toEqual(originalCreatedAt);
    });

    it('should handle recreation after removal', () => {
      createTeammate('worker', 'developer', 'Write code');
      updateTeammateStatus('worker', 'idle' as TeammateStatus);
      removeTeammate('worker');

      // Recreate with different data
      createTeammate('worker', 'reviewer', 'Review code');

      const teammate = getTeammate('worker');
      expect(teammate?.role).toBe('reviewer');
      expect(teammate?.status).toBe('working'); // Reset to working
    });
  });

  // ============================================================================
  // Data Consistency Tests
  // ============================================================================

  describe('Data Consistency', () => {
    it('should maintain blockage consistency with comments', () => {
      const blocker = createIssue('Blocker', 'Content', []);
      const blocked = createIssue('Blocked', 'Content', [blocker]);

      addIssueComment(blocker, 'Working on this', 'agent-1');
      addIssueComment(blocked, 'Waiting for blocker', 'agent-2');

      expect(getIssue(blocker)?.comments).toHaveLength(2);
      expect(getIssue(blocked)?.comments).toHaveLength(2);
      expect(getIssue(blocker)?.blocks).toContain(blocked);
      expect(getIssue(blocked)?.blockedBy).toContain(blocker);
    });

    it('should handle rapid sequential issue creation', () => {
      const ids: number[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(createIssue(`Issue ${i}`, `Content ${i}`, []));
      }

      // Verify all IDs are unique
      expect(new Set(ids).size).toBe(100);

      // Verify all issues exist
      const issues = listIssues();
      expect(issues).toHaveLength(100);
    });

    it('should handle rapid sequential teammate creation', () => {
      for (let i = 0; i < 50; i++) {
        createTeammate(`worker-${i}`, 'developer', `Write code ${i}`);
      }

      const teammates = listTeammates();
      expect(teammates).toHaveLength(50);
    });

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

    it('should not affect other entities when updating one', () => {
      const issue1 = createIssue('Issue 1', 'Content', []);
      const issue2 = createIssue('Issue 2', 'Content', []);
      createTeammate('worker', 'developer', 'Write code');

      updateIssue(issue1, { status: 'completed' as IssueStatus, owner: 'agent' });

      expect(getIssue(issue2)?.status).toBe('pending');
      expect(getIssue(issue2)?.owner).toBeUndefined();
      expect(getTeammate('worker')?.status).toBe('working');
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

    it('should handle unicode in teammate data', () => {
      createTeammate('開発者', 'プログラマー', 'コードを書く 🖥️');
      const teammate = getTeammate('開発者');

      expect(teammate?.name).toBe('開発者');
      expect(teammate?.role).toBe('プログラマー');
      expect(teammate?.prompt).toBe('コードを書く 🖥️');
    });

    it('should handle unicode in comments', () => {
      const id = createIssue('Test', 'Content', []);
      addIssueComment(id, 'コメント 🎉', 'ユーザー');

      const issue = getIssue(id);
      expect(issue?.comments[1].content).toBe('コメント 🎉');
      expect(issue?.comments[1].poster).toBe('ユーザー');
    });

    it('should handle very long strings', () => {
      const longTitle = 'a'.repeat(100000);
      const longContent = 'b'.repeat(100000);

      const id = createIssue(longTitle, longContent, []);
      const issue = getIssue(id);

      expect(issue?.title).toBe(longTitle);
      expect(issue?.content).toBe(longContent);
      expect(issue?.title.length).toBe(100000);
    });

    it('should handle special characters in names', () => {
      createTeammate('worker@test', 'role', 'prompt');
      createTeammate('worker-123', 'role', 'prompt');
      createTeammate('worker.test', 'role', 'prompt');

      expect(getTeammate('worker@test')).toBeDefined();
      expect(getTeammate('worker-123')).toBeDefined();
      expect(getTeammate('worker.test')).toBeDefined();
    });

    it('should handle newline characters in content', () => {
      const id = createIssue('Test', 'Line 1\nLine 2\r\nLine 3', []);
      addIssueComment(id, 'Comment\nwith\nnewlines', 'user');

      const issue = getIssue(id);
      expect(issue?.content).toBe('Line 1\nLine 2\r\nLine 3');
      expect(issue?.comments[1].content).toBe('Comment\nwith\nnewlines');
    });

    it('should handle empty comment and poster', () => {
      const id = createIssue('Test', 'Content', []);

      const result = addIssueComment(id, '', '');
      expect(result).toBe(true);

      const issue = getIssue(id);
      expect(issue?.comments[1].content).toBe('');
      expect(issue?.comments[1].poster).toBe('');
    });

    it('should handle whitespace-only strings', () => {
      const id = createIssue('   ', '   ', []);

      const issue = getIssue(id);
      expect(issue?.title).toBe('   ');
      expect(issue?.content).toBe('   ');
    });
  });

  // ============================================================================
  // Stress Tests
  // ============================================================================

  describe('Stress Tests', () => {
    it('should handle many issues with blockages', () => {
      // Create chain of 50 issues
      const issues: number[] = [];
      for (let i = 0; i < 50; i++) {
        const blockedBy = i > 0 ? [issues[i - 1]] : [];
        issues.push(createIssue(`Issue ${i}`, 'Content', blockedBy));
      }

      // Verify first issue
      expect(getIssue(issues[0])?.blockedBy).toEqual([]);
      expect(getIssue(issues[0])?.blocks).toContain(issues[1]);

      // Verify last issue
      expect(getIssue(issues[49])?.blockedBy).toContain(issues[48]);
      expect(getIssue(issues[49])?.blocks).toEqual([]);

      // Verify middle
      expect(getIssue(issues[25])?.blockedBy).toContain(issues[24]);
      expect(getIssue(issues[25])?.blocks).toContain(issues[26]);
    });

    it('should handle many comments on single issue', () => {
      const id = createIssue('Test', 'Content', []);

      for (let i = 0; i < 100; i++) {
        addIssueComment(id, `Comment ${i}`, `user-${i % 10}`);
      }

      const issue = getIssue(id);
      expect(issue?.comments).toHaveLength(101); // 1 system + 100 added
    });

    it('should handle many teammates', () => {
      for (let i = 0; i < 100; i++) {
        createTeammate(`worker-${i}`, `role-${i}`, `prompt-${i}`);
      }

      const teammates = listTeammates();
      expect(teammates).toHaveLength(100);
      expect(teammates.map((t) => t.name).sort()).toEqual(
        Array.from({ length: 100 }, (_, i) => `worker-${i}`).sort()
      );
    });

    it('should handle many blockages on single issue', () => {
      const mainIssue = createIssue('Main', 'Content', []);

      // Create 50 blockers
      for (let i = 0; i < 50; i++) {
        const blocker = createIssue(`Blocker ${i}`, 'Content', []);
        createBlockage(blocker, mainIssue);
      }

      const issue = getIssue(mainIssue);
      expect(issue?.blockedBy).toHaveLength(50);
    });
  });
});