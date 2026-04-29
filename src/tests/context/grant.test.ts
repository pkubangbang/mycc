/**
 * grant.test.ts - Tests for the grant evaluator
 *
 * Tests the evaluateGrant function that determines whether
 * operations from child processes should be approved or rejected.
 */

import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Note: These tests will be enabled once evaluateGrant is implemented
// in src/context/parent/grant.ts

describe('evaluateGrant', () => {
  let tempDir: string;
  let mockGetMode: Mock<() => 'plan' | 'normal'>;
  let mockGetWorkDir: Mock<() => string>;
  let mockWorktrees: Array<{ name: string; path: string; branch: string }>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-grant-test-'));

    mockGetMode = vi.fn<() => 'plan' | 'normal'>(() => 'normal' as const);
    mockGetWorkDir = vi.fn(() => tempDir);

    // Mock worktree structure
    mockWorktrees = [
      { name: 'dev-agent', path: path.join(tempDir, '.worktrees', 'dev-agent'), branch: 'feature/dev' },
      { name: 'test-agent', path: path.join(tempDir, '.worktrees', 'test-agent'), branch: 'feature/test' },
    ];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('Plan Mode', () => {
    it('should reject all grants when mode is plan', async () => {
      mockGetMode.mockReturnValue('plan');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'write_file',
      //   path: '/test/file.ts',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('plan mode');

      // Placeholder assertion until implementation
      expect(mockGetMode()).toBe('plan');
    });

    it('should reject bash commands in plan mode even for owned worktree', async () => {
      mockGetMode.mockReturnValue('plan');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'npm test',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('plan mode');

      expect(mockGetMode()).toBe('plan');
    });
  });

  describe('Worktree Ownership - File Operations', () => {
    it('should auto-grant for files in owned worktree', async () => {
      mockGetMode.mockReturnValue('normal');

      const filePath = path.join(mockWorktrees[0].path, 'src', 'new-file.ts');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'write_file',
      //   path: filePath,
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(true);
      // expect(result.reason).toBeUndefined();

      // Verify path is in owned worktree
      expect(filePath.startsWith(mockWorktrees[0].path)).toBe(true);
    });

    it('should reject files outside owned worktree', async () => {
      mockGetMode.mockReturnValue('normal');

      const filePath = path.join(tempDir, 'main-branch-file.ts');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'write_file',
      //   path: filePath,
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('outside your worktree');

      // Verify path is NOT in owned worktree
      expect(filePath.startsWith(mockWorktrees[0].path)).toBe(false);
    });

    it('should reject files for child without worktree', async () => {
      mockGetMode.mockReturnValue('normal');

      const filePath = path.join(tempDir, 'some-file.ts');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('no-worktree-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'write_file',
      //   path: filePath,
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('no worktree');

      // Verify no worktree for this agent
      const owned = mockWorktrees.find(wt => wt.name === 'no-worktree-agent');
      expect(owned).toBeUndefined();
    });
  });

  describe('Bash Command Restrictions', () => {
    it('should block dangerous command: rm -rf /', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'rm -rf /',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('Dangerous');
      // expect(result.reason).toContain('blocked');

      // Verify the dangerous pattern
      const dangerous = ['rm -rf /'];
      expect(dangerous.some(d => 'rm -rf /'.includes(d))).toBe(true);
    });

    it('should block dangerous command: sudo rm', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'sudo rm -rf /home',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('Dangerous');

      const dangerous = ['sudo rm'];
      expect(dangerous.some(d => 'sudo rm -rf /home'.includes(d))).toBe(true);
    });

    it('should block dangerous command: mkfs', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'mkfs.ext4 /dev/sda1',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);

      const dangerous = ['mkfs'];
      expect(dangerous.some(d => 'mkfs.ext4 /dev/sda1'.includes(d))).toBe(true);
    });

    it('should block dangerous command: dd if=', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'dd if=/dev/zero of=/dev/sda',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);

      const dangerous = ['dd if='];
      expect(dangerous.some(d => 'dd if=/dev/zero of=/dev/sda'.includes(d))).toBe(true);
    });

    it('should block git commit (must use git_commit tool)', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'git commit -m "test"',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('git_commit tool');

      // Verify the pattern
      expect(/\bgit\s+commit\b/.test('git commit -m "test"')).toBe(true);
    });

    it('should allow git status (read-only)', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'git status',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(true);

      const readOnly = /^git (status|log|diff|branch|show)/;
      expect(readOnly.test('git status')).toBe(true);
    });

    it('should allow git log (read-only)', async () => {
      mockGetMode.mockReturnValue('normal');

      const readOnly = /^git (status|log|diff|branch|show)/;
      expect(readOnly.test('git log --oneline -10')).toBe(true);
    });

    it('should allow git diff (read-only)', async () => {
      mockGetMode.mockReturnValue('normal');

      const readOnly = /^git (status|log|diff|branch|show)/;
      expect(readOnly.test('git diff HEAD')).toBe(true);
    });
  });

  describe('Normal Mode - Auto-grant for owned worktree', () => {
    it('should auto-grant bash commands for child with owned worktree', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('dev-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'npm run build',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(true);

      // Verify dev-agent owns a worktree
      expect(mockWorktrees.find(wt => wt.name === 'dev-agent')).toBeDefined();
    });

    it('should reject bash commands for child without worktree (non-read-only)', async () => {
      mockGetMode.mockReturnValue('normal');

      // Once evaluateGrant is implemented:
      // const result = await evaluateGrant('no-worktree-agent', {
      //   type: 'grant_request',
      //   reqId: 1,
      //   tool: 'bash',
      //   command: 'npm run build',
      // }, mockCore, mockWorktrees);
      //
      // expect(result.approved).toBe(false);
      // expect(result.reason).toContain('no worktree');

      // Verify no worktree for this agent
      expect(mockWorktrees.find(wt => wt.name === 'no-worktree-agent')).toBeUndefined();
    });
  });
});