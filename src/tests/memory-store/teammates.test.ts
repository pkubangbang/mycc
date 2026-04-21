/**
 * Tests for Teammate management
 *
 * Includes:
 * - createTeammate, getTeammate, listTeammates, updateTeammateStatus, removeTeammate
 * - Teammate status transitions
 * - Teammate-related edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTeammate,
  getTeammate,
  listTeammates,
  updateTeammateStatus,
  removeTeammate,
  clearAll,
} from '../../context/memory-store.js';
import type { TeammateStatus } from '../../types.js';

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
  // Teammate Management
  // ============================================================================

  describe('Teammate Operations', () => {
    describe('createTeammate', () => {
      it('should create teammate with valid data', () => {
        createTeammate('worker-1', 'developer', 'Write code');

        const teammate = getTeammate('worker-1');
        expect(teammate).toBeDefined();
        expect(teammate?.name).toBe('worker-1');
        expect(teammate?.role).toBe('developer');
        expect(teammate?.status).toBe('working');
        expect(teammate?.prompt).toBe('Write code');
        expect(teammate?.createdAt).toBeInstanceOf(Date);
      });

      it('should overwrite existing teammate with same name', () => {
        createTeammate('worker-1', 'developer', 'Write code');
        createTeammate('worker-1', 'tester', 'Test code');

        const teammate = getTeammate('worker-1');
        expect(teammate?.role).toBe('tester');
        expect(teammate?.prompt).toBe('Test code');
        expect(teammate?.status).toBe('working'); // Reset to working
      });

      it('should create multiple teammates', () => {
        createTeammate('worker-1', 'developer', 'Write code');
        createTeammate('worker-2', 'tester', 'Test code');
        createTeammate('worker-3', 'reviewer', 'Review code');

        const teammates = listTeammates();
        expect(teammates).toHaveLength(3);
      });
    });

    describe('getTeammate', () => {
      it('should return teammate by name', () => {
        createTeammate('worker-1', 'developer', 'Write code');

        const teammate = getTeammate('worker-1');
        expect(teammate?.name).toBe('worker-1');
      });

      it('should return undefined for non-existent teammate', () => {
        const teammate = getTeammate('non-existent');
        expect(teammate).toBeUndefined();
      });

      it('should return undefined after clearAll', () => {
        createTeammate('worker-1', 'developer', 'Write code');
        expect(getTeammate('worker-1')).toBeDefined();

        clearAll();

        expect(getTeammate('worker-1')).toBeUndefined();
      });
    });

    describe('listTeammates', () => {
      it('should return empty array when no teammates exist', () => {
        const teammates = listTeammates();
        expect(teammates).toEqual([]);
      });

      it('should return all teammates', () => {
        createTeammate('worker-1', 'developer', 'Write code');
        createTeammate('worker-2', 'tester', 'Test code');

        const teammates = listTeammates();
        expect(teammates).toHaveLength(2);
        expect(teammates.map((t) => t.name)).toContain('worker-1');
        expect(teammates.map((t) => t.name)).toContain('worker-2');
      });
    });

    describe('updateTeammateStatus', () => {
      it('should update teammate status', () => {
        createTeammate('worker-1', 'developer', 'Write code');

        const result = updateTeammateStatus('worker-1', 'idle' as TeammateStatus);

        expect(result).toBe(true);
        expect(getTeammate('worker-1')?.status).toBe('idle');
      });

      it('should cycle through all valid statuses', () => {
        createTeammate('worker-1', 'developer', 'Write code');

        const statuses: TeammateStatus[] = ['working', 'idle', 'holding', 'shutdown'];

        for (const status of statuses) {
          updateTeammateStatus('worker-1', status);
          expect(getTeammate('worker-1')?.status).toBe(status);
        }
      });

      it('should return false for non-existent teammate', () => {
        const result = updateTeammateStatus('non-existent', 'idle' as TeammateStatus);
        expect(result).toBe(false);
      });
    });

    describe('removeTeammate', () => {
      it('should remove existing teammate', () => {
        createTeammate('worker-1', 'developer', 'Write code');

        const result = removeTeammate('worker-1');

        expect(result).toBe(true);
        expect(getTeammate('worker-1')).toBeUndefined();
      });

      it('should return false for non-existent teammate', () => {
        const result = removeTeammate('non-existent');
        expect(result).toBe(false);
      });

      it('should not affect other teammates', () => {
        createTeammate('worker-1', 'developer', 'Write code');
        createTeammate('worker-2', 'tester', 'Test code');

        removeTeammate('worker-1');

        expect(listTeammates()).toHaveLength(1);
        expect(getTeammate('worker-2')).toBeDefined();
      });
    });
  });

  // ============================================================================
  // Teammate State Transitions
  // ============================================================================

  describe('Teammate State Transitions', () => {
    it('should transition from working to idle', () => {
      createTeammate('worker', 'developer', 'Write code');
      updateTeammateStatus('worker', 'idle' as TeammateStatus);

      expect(getTeammate('worker')?.status).toBe('idle');
    });

    it('should transition from idle to working', () => {
      createTeammate('worker', 'developer', 'Write code');
      updateTeammateStatus('worker', 'idle' as TeammateStatus);
      updateTeammateStatus('worker', 'working' as TeammateStatus);

      expect(getTeammate('worker')?.status).toBe('working');
    });

    it('should transition from working to shutdown', () => {
      createTeammate('worker', 'developer', 'Write code');
      updateTeammateStatus('worker', 'shutdown' as TeammateStatus);

      expect(getTeammate('worker')?.status).toBe('shutdown');
    });

    it('should transition from holding to working', () => {
      createTeammate('worker', 'developer', 'Write code');
      updateTeammateStatus('worker', 'holding' as TeammateStatus);
      updateTeammateStatus('worker', 'working' as TeammateStatus);

      expect(getTeammate('worker')?.status).toBe('working');
    });
  });

  // ============================================================================
  // Teammate Edge Cases
  // ============================================================================

  describe('Teammate Edge Cases', () => {
    describe('Duplicate handling', () => {
      it('should handle duplicate teammate creation (overwrite)', () => {
        createTeammate('worker', 'developer', 'Write code');
        createTeammate('worker', 'reviewer', 'Review code');

        const teammate = getTeammate('worker');
        expect(teammate?.role).toBe('reviewer');
        expect(listTeammates()).toHaveLength(1);
      });
    });

    describe('Non-existent entities', () => {
      it('should handle getTeammate for non-existent name', () => {
        expect(getTeammate('non-existent')).toBeUndefined();
      });

      it('should handle updateTeammateStatus for non-existent name', () => {
        expect(updateTeammateStatus('non-existent', 'idle' as TeammateStatus)).toBe(false);
      });

      it('should handle removeTeammate for non-existent name', () => {
        expect(removeTeammate('non-existent')).toBe(false);
      });
    });

    describe('Empty state', () => {
      it('should list empty teammates', () => {
        expect(listTeammates()).toEqual([]);
      });
    });

    describe('Special characters and boundaries', () => {
      it('should handle teammate with empty role', () => {
        createTeammate('worker', '', 'Prompt');
        expect(getTeammate('worker')?.role).toBe('');
      });

      it('should handle teammate with empty prompt', () => {
        createTeammate('worker', 'role', '');
        expect(getTeammate('worker')?.prompt).toBe('');
      });

      it('should handle special characters in teammate name', () => {
        createTeammate('worker-test_123', 'role', 'prompt');
        expect(getTeammate('worker-test_123')).toBeDefined();
      });
    });
  });
});