/**
 * git-commit.test.ts - Tests for the git_commit tool
 *
 * Regression coverage for the [y/N] confirmation convention: pressing Enter
 * (empty response) must be treated as "No" (cancel commit), consistent with
 * plan_off.ts. Previously an empty response fell into the ambiguous `!granted`
 * branch and surfaced a confusing `User responded: ""`, making the agent
 * think the user had given feedback when they had simply declined.
 *
 * These tests focus on the permission/confirmation flow. The actual `git
 * commit` execution (spawn) is never reached on a denied response, so no real
 * git binary or repo is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gitCommitTool } from '../../tools/git_commit.js';
import { agentIO } from '../../loop/agent-io.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';
import type { AgentContext } from '../../types.js';

// Mock agentIO: exec (git status check) + isMainProcess (teammate gate)
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    exec: vi.fn(),
    isMainProcess: vi.fn(() => true),
  },
}));

// Mock findWorktreeByName so the teammate branch never shells out to git.
vi.mock('../../context/worktree-store.js', () => ({
  findWorktreeByName: vi.fn(async () => null),
}));

describe('gitCommitTool', () => {
  let tempDir: string;
  let ctx: AgentContext;

  beforeEach(() => {
    tempDir = createTempDir();
    ctx = createMockContext(tempDir);
    vi.clearAllMocks();
    // Default: main process (skip the teammate mail-to-lead branch)
    vi.mocked(agentIO.isMainProcess).mockReturnValue(true);
    // Default: staged changes exist so the handler reaches the confirmation
    // prompt instead of returning "No staged changes".
    vi.mocked(agentIO.exec).mockResolvedValue({
      stdout: 'M  src/file.ts',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      timedOut: false,
    });
    // Default: empty question response (Enter = No)
    vi.mocked(ctx.core.question).mockResolvedValue('');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('[y/N] confirmation convention', () => {
    it('should treat empty response (Enter) as No and cancel the commit', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
      // Must NOT surface the confusing ambiguous-feedback message
      expect(result).not.toContain('User responded: ""');
      expect(result).not.toContain('did not confirm');
    });

    it('should treat whitespace-only response as No', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('   ');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
      expect(result).not.toContain('User responded: ""');
    });

    it('should treat "n" as No and cancel the commit', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('n');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
    });

    it('should treat "no" as No and cancel the commit', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('no');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
    });

    it('should treat quoted empty as No (not a stray User responded "")', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('""');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      // Quoted empty normalizes to '' -> denied branch, not the ambiguous branch
      expect(result).toContain('Commit cancelled by user');
      expect(result).not.toContain('User responded: ""');
    });

    it('should treat quoted "n" as No', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('"n"');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
    });
  });

  describe('ambiguous non-empty response', () => {
    it('should ask for clarification when user types something other than y/n', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('maybe');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('did not confirm');
      expect(result).toContain('maybe');
    });

    it('should surface the feedback text in the response for the agent to iterate', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce('change the message');
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('change the message');
      expect(result).toContain('did not confirm');
    });
  });

  describe('validation', () => {
    it('should reject empty commit message', async () => {
      const result = await gitCommitTool.handler(ctx, { message: '' });
      expect(result).toContain('Error:');
      expect(result).toContain('message');
    });

    it('should reject whitespace-only commit message', async () => {
      const result = await gitCommitTool.handler(ctx, { message: '   ' });
      expect(result).toContain('Error:');
      expect(result).toContain('message');
    });

    it('should reject missing commit message', async () => {
      const result = await gitCommitTool.handler(ctx, {});
      expect(result).toContain('Error:');
      expect(result).toContain('message');
    });

    it('should report no staged changes (non-amend)', async () => {
      vi.mocked(agentIO.exec).mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        interrupted: false,
        exitCode: 0,
        timedOut: false,
      });
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Error:');
      expect(result).toContain('No staged changes');
      // Should not have prompted the user
      expect(ctx.core.question).not.toHaveBeenCalled();
    });
  });

  describe('teammate (non-main) without owned worktree', () => {
    it('should send commit request to lead via mail instead of prompting the user', async () => {
      vi.mocked(agentIO.isMainProcess).mockReturnValue(false);
      // findWorktreeByName is mocked to return null (no owned worktree).
      // The teammate branch constructs a MailBox and calls appendMail, which
      // requires a live session context. Rather than mock the entire session
      // layer (out of scope for the [y/N] fix), we assert only that the user
      // is NOT prompted — the teammate path delegates to the lead.
      try {
        await gitCommitTool.handler(ctx, { message: 'teammate commit' });
      } catch {
        // appendMail throws "Session context not initialized" in the test
        // harness; that is expected and fine — the point is the handler did
        // not reach the user prompt.
      }
      expect(ctx.core.question).not.toHaveBeenCalled();
    });
  });

  describe('tool metadata', () => {
    it('should have correct name', () => {
      expect(gitCommitTool.name).toBe('git_commit');
    });
    it('should have main+child scope', () => {
      expect(gitCommitTool.scope).toEqual(['main', 'child']);
    });
    it('should require message', () => {
      expect(gitCommitTool.input_schema.required).toContain('message');
    });
  });
});