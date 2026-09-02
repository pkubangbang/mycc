/**
 * grant.test.ts - Tests for the grant evaluator
 *
 * Tests the evaluateGrant function that determines whether
 * operations from child processes should be approved or rejected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock bash-judge so evaluateGrant's bash path is deterministic (no LLM).
vi.mock('../../context/grant/bash-judge.js', () => ({
  judgeBash: vi.fn(),
}));

// Mock worktree-store so listWorktrees returns a controlled set.
vi.mock('../../context/worktree-store.js', () => ({
  listWorktrees: vi.fn(),
}));

// Mock config for plan-mode-writable dirs.
vi.mock('../../config.js', () => ({
  getPlanModeWritableDirs: vi.fn(() => ['.mycc/longtext', '.mycc/imgcache']),
}));

import { evaluateGrant } from '../../context/grant/grant-evaluator.js';
import { judgeBash } from '../../context/grant/bash-judge.js';
import { listWorktrees } from '../../context/worktree-store.js';
import type { GrantRequest } from '../../context/grant/types.js';

// A minimal Core-shaped object with the methods evaluateGrant touches.
function makeCore(workDir: string, mode: 'plan' | 'normal' = 'normal', allowedFile?: string) {
  return {
    getMode: () => mode,
    getWorkDir: () => workDir,
    getAllowedFile: () => allowedFile,
    question: vi.fn(),
    escAware: vi.fn(),
  } as unknown as Parameters<typeof evaluateGrant>[2];
}

describe('evaluateGrant', () => {
  let tempDir: string;
  let worktreePath: string;
  const mockJudgeBash = vi.mocked(judgeBash);
  const mockListWorktrees = vi.mocked(listWorktrees);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-grant-test-'));
    worktreePath = path.join(tempDir, '.worktrees', 'dev-agent');
    fs.mkdirSync(worktreePath, { recursive: true });

    mockJudgeBash.mockReset();
    mockListWorktrees.mockReset();
    mockListWorktrees.mockResolvedValue([
      { name: 'dev-agent', path: worktreePath, branch: 'feature/dev' },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('Plan Mode', () => {
    it('should reject file writes in plan mode', async () => {
      const core = makeCore(tempDir, 'plan');
      const result = await evaluateGrant('dev-agent', {
        tool: 'write_file',
        path: path.join(tempDir, 'src', 'file.ts'),
      }, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Plan mode');
    });

    it('should reject bash commands in plan mode even for owned worktree', async () => {
      mockJudgeBash.mockResolvedValue({
        decision: 'block',
        reason: 'Cannot BUILD in plan mode. Verb "BUILD" modifies state.',
      });
      const core = makeCore(tempDir, 'plan');
      const result = await evaluateGrant('dev-agent', {
        tool: 'bash',
        command: 'npm run build',
        intent: 'BUILD ARTIFACT TO compile project',
      }, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Cannot BUILD in plan mode');
    });

    it('should allow writes into plan-mode-writable tool-output dirs', async () => {
      const core = makeCore(tempDir, 'plan');
      const result = await evaluateGrant('dev-agent', {
        tool: 'write_file',
        path: path.join(tempDir, '.mycc', 'longtext', 'dump.txt'),
      }, core);

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should allow the single allowed file in plan mode', async () => {
      const allowed = path.join(tempDir, 'src', 'allowed.ts');
      const core = makeCore(tempDir, 'plan', allowed);
      const result = await evaluateGrant('dev-agent', {
        tool: 'edit_file',
        path: allowed,
      }, core);

      expect(result.approved).toBe(true);
    });
  });

  describe('Worktree Ownership - File Operations', () => {
    it('should auto-grant for files in owned worktree', async () => {
      const core = makeCore(tempDir, 'normal');
      const filePath = path.join(worktreePath, 'src', 'new-file.ts');
      const result = await evaluateGrant('dev-agent', {
        tool: 'write_file',
        path: filePath,
      }, core);

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject files outside owned worktree and project root', async () => {
      const core = makeCore(tempDir, 'normal');
      const filePath = path.join(os.tmpdir(), 'unrelated-dir', 'main-branch-file.ts');
      const result = await evaluateGrant('dev-agent', {
        tool: 'write_file',
        path: filePath,
      }, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('outside your worktree');
    });

    it('should allow writes within project root for child without worktree', async () => {
      // A child with no owned worktree falls back to allowing writes within
      // the project root (general project work, not worktree-specific).
      mockListWorktrees.mockResolvedValue([]);
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('no-worktree-agent', {
        tool: 'write_file',
        path: path.join(tempDir, 'src', 'file.ts'),
      }, core);

      expect(result.approved).toBe(true);
    });

    it('should reject writes outside project root for child without worktree', async () => {
      mockListWorktrees.mockResolvedValue([]);
      const core = makeCore(tempDir, 'normal');
      const outside = path.join(os.tmpdir(), 'unrelated-dir', 'file.ts');
      const result = await evaluateGrant('no-worktree-agent', {
        tool: 'write_file',
        path: outside,
      }, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('outside your worktree');
    });

    it('should reject file op with no path', async () => {
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('dev-agent', {
        tool: 'write_file',
      } as GrantRequest, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('No path provided');
    });
  });

  describe('Bash Command Restrictions', () => {
    it('should block dangerous command: rm -rf /', async () => {
      mockJudgeBash.mockResolvedValue({
        decision: 'block',
        reason: 'Command blocked: rm -rf / is destructive',
      });
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('dev-agent', {
        tool: 'bash',
        command: 'rm -rf /',
        intent: 'DELETE DATA dangerous=i_know TO reclaim disk space',
      }, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('should block git commit (must use git_commit tool)', async () => {
      mockJudgeBash.mockResolvedValue({
        decision: 'block',
        reason: 'Command blocked: git commit must use the git_commit tool',
      });
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('dev-agent', {
        tool: 'bash',
        command: 'git commit -m "test"',
        intent: 'RUN SYSTEM TO commit changes',
      }, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('git_commit tool');
    });

    it('should allow read-only git status', async () => {
      mockJudgeBash.mockResolvedValue({ decision: 'allow' });
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('dev-agent', {
        tool: 'bash',
        command: 'git status',
        intent: 'READ SOURCE TO check repo state',
      }, core);

      expect(result.approved).toBe(true);
    });

    it('should reject bash with no command', async () => {
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('dev-agent', {
        tool: 'bash',
      } as GrantRequest, core);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('No command provided');
    });
  });

  describe('Normal Mode - Auto-grant for owned worktree', () => {
    it('should auto-grant bash commands for child with owned worktree', async () => {
      mockJudgeBash.mockResolvedValue({ decision: 'allow' });
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('dev-agent', {
        tool: 'bash',
        command: 'npm run build',
        intent: 'BUILD ARTIFACT TO compile project',
      }, core);

      expect(result.approved).toBe(true);
    });

    it('should reject bash commands for child without worktree (non-read-only)', async () => {
      mockJudgeBash.mockResolvedValue({
        decision: 'block',
        reason: 'Batch deletion from child process is not allowed.',
      });
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('no-worktree-agent', {
        tool: 'bash',
        command: 'rm -rf node_modules',
        intent: 'DELETE TEMP batch=i_know TO clean build artifacts',
      }, core);

      expect(result.approved).toBe(false);
    });
  });

  describe('Lead (parent) in normal mode', () => {
    it('should allow file writes for lead', async () => {
      const core = makeCore(tempDir, 'normal');
      const result = await evaluateGrant('lead', {
        tool: 'write_file',
        path: path.join(tempDir, 'src', 'file.ts'),
      }, core);

      expect(result.approved).toBe(true);
    });
  });
});
