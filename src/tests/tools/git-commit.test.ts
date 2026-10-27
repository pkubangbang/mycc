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
import { createMockContext, createTempDir, removeTempDir, askResult } from './test-utils.js';
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

// Mock the config getters that back the --allow-auto-commit pre-authorization.
// The test harness cannot inject argv, so the two predicates are the seam:
// tests toggle the grant by re-mocking these between cases.
vi.mock('../../config.js', () => ({
  isAllowAutoCommit: vi.fn(() => false),
  getAllowAutoCommitBranches: vi.fn(() => [] as string[]),
}));

import { isAllowAutoCommit, getAllowAutoCommitBranches } from '../../config.js';

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
    vi.mocked(ctx.core.question).mockResolvedValue(askResult(''));
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('[y/N] confirmation convention', () => {
    it('should treat empty response (Enter) as No and cancel the commit', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult(''));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
      // Must NOT surface the confusing ambiguous-feedback message
      expect(result).not.toContain('User responded: ""');
      expect(result).not.toContain('did not confirm');
    });

    it('should treat whitespace-only response as No', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('   '));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
      expect(result).not.toContain('User responded: ""');
    });

    it('should treat "n" as No and cancel the commit', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
    });

    it('should treat "no" as No and cancel the commit', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('no'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
    });

    it('should treat quoted empty as No (not a stray User responded "")', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('""'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      // Quoted empty normalizes to '' -> denied branch, not the ambiguous branch
      expect(result).toContain('Commit cancelled by user');
      expect(result).not.toContain('User responded: ""');
    });

    it('should treat quoted "n" as No', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('"n"'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
    });
  });

  describe('auto-mode rejection', () => {
    it('should report auto mode is on (not "cancelled by user") when denied in auto mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n', 'auto'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('auto mode is ON');
      expect(result).toContain('exit auto mode');
      expect(result).toContain('ESC');
      // Must NOT surface the plain user-denial message
      expect(result).not.toContain('Commit cancelled by user');
    });

    it('should report auto mode is on when empty (Enter) response in auto mode', async () => {
      // In auto mode question() returns the onEsc default ('n' for git_commit),
      // which normalizes to '' -> denied. The handler must still detect auto mode
      // via source === 'auto' (no longer via getAuto()).
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('', 'auto'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('auto mode is ON');
      expect(result).not.toContain('Commit cancelled by user');
    });

    it('should still return "cancelled by user" when denied outside auto mode', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('Commit cancelled by user');
      expect(result).not.toContain('auto mode is ON');
    });
  });

  describe('ambiguous non-empty response', () => {
    it('should ask for clarification when user types something other than y/n', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('maybe'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('did not confirm');
      expect(result).toContain('maybe');
    });

    it('should surface the feedback text in the response for the agent to iterate', async () => {
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('change the message'));
      const result = await gitCommitTool.handler(ctx, { message: 'test commit' });
      expect(result).toContain('change the message');
      expect(result).toContain('did not confirm');
    });
  });

  describe('validation', () => {
    it('should reject empty commit message', async () => {
      const result = await gitCommitTool.handler(ctx, { message: '' });
      expect(result).toBe('Error: The "message" parameter is required and must be a non-empty string');
    });

    it('should reject whitespace-only commit message', async () => {
      const result = await gitCommitTool.handler(ctx, { message: '   ' });
      expect(result).toBe('Error: The "message" parameter is required and must be a non-empty string');
    });

    it('should reject missing commit message', async () => {
      const result = await gitCommitTool.handler(ctx, {});
      expect(result).toBe('Error: The "message" parameter is required and must be a non-empty string');
    });

    it('should reject non-string commit message', async () => {
      const result = await gitCommitTool.handler(ctx, { message: 123 as unknown as string });
      expect(result).toBe('Error: The "message" parameter is required and must be a non-empty string');
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
      expect(result).toBe('Error: No staged changes to commit. Use `git add` to stage changes first.');
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

  describe('--allow-auto-commit pre-authorization', () => {
    /** Point agentIO.exec at a repo whose current branch is `branch`. */
    const onBranch = (branch: string): void => {
      vi.mocked(agentIO.exec).mockImplementation(async ({ command }) => {
        if (command.includes('rev-parse')) {
          return { stdout: `${branch}\n`, stderr: '', interrupted: false, exitCode: 0, timedOut: false };
        }
        // `git status --porcelain`: keep one staged file so the handler reaches
        // the pre-authorization gate.
        return { stdout: 'M  src/file.ts', stderr: '', interrupted: false, exitCode: 0, timedOut: false };
      });
    };

    const grant = (branches: string[]): void => {
      vi.mocked(isAllowAutoCommit).mockReturnValue(true);
      vi.mocked(getAllowAutoCommitBranches).mockReturnValue(branches);
    };

    it('auto-commits without prompting when auto mode + allow-listed branch', async () => {
      grant(['main']);
      vi.mocked(ctx.core.getAuto).mockReturnValue(true);
      onBranch('main');

      const result = await gitCommitTool.handler(ctx, { message: 'auto commit' });

      // The whole point: the interactive prompt is SKIPPED.
      expect(ctx.core.question).not.toHaveBeenCalled();
      // A real `git commit` child was spawned (it fails in the temp dir with no
      // repo, but we only assert the handler passed the permission gate — a
      // "Commit cancelled/rejected" string would mean it never got there).
      expect(result).not.toContain('Commit cancelled by user');
      expect(result).not.toContain('auto mode is ON');
    });

    it('emits the audit trailer with the AUTHORIZED branch on a real repo', async () => {
      // Real repo so the spawn actually commits and we can read the message
      // back — this pins the Auto-Committed-By / Auto-Commit-Branch trailer
      // AND (via capturing rev-parse only once) the TOCTOU fix.
      const { execFileSync } = await import('child_process');
      const run = (c: string[]) => execFileSync('git', c, { cwd: tempDir });
      run(['init', '-q']);
      run(['config', 'user.email', 't@t.t']);
      run(['config', 'user.name', 't']);
      const { writeFileSync } = await import('fs');
      writeFileSync(`${tempDir}/a.txt`, 'x');
      run(['add', 'a.txt']);
      // Only rev-parse is mocked; git status + commit run against the real repo.
      vi.mocked(agentIO.exec).mockImplementation(async ({ command }) => {
        if (command.includes('rev-parse')) {
          return { stdout: 'main\n', stderr: '', interrupted: false, exitCode: 0, timedOut: false };
        }
        const out = execFileSync('git', ['status', '--porcelain'], { cwd: tempDir }).toString();
        return { stdout: out, stderr: '', interrupted: false, exitCode: 0, timedOut: false };
      });
      grant(['main']);
      vi.mocked(ctx.core.getAuto).mockReturnValue(true);

      const result = await gitCommitTool.handler(ctx, { message: 'auto commit body' });

      expect(result).toContain('Commit successful');
      expect(ctx.core.question).not.toHaveBeenCalled();
      const log = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: tempDir }).toString();
      expect(log).toContain('auto commit body');
      expect(log).toContain('Auto-Committed-By: mycc --allow-auto-commit');
      expect(log).toContain('Auto-Commit-Branch: main');
    });

    it('falls through to the auto-deny path when the branch is not allow-listed', async () => {
      grant(['release']);
      vi.mocked(ctx.core.getAuto).mockReturnValue(true);
      onBranch('feature/foo');
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n', 'auto'));

      const result = await gitCommitTool.handler(ctx, { message: 'nope' });

      expect(ctx.core.question).toHaveBeenCalled();
      expect(result).toContain('auto mode is ON');
    });

    it('still prompts (no bypass) when the lead is NOT in auto mode', async () => {
      grant(['main']);
      vi.mocked(ctx.core.getAuto).mockReturnValue(false);
      onBranch('main');
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n'));

      const result = await gitCommitTool.handler(ctx, { message: 'manual' });

      expect(ctx.core.question).toHaveBeenCalled();
      expect(result).toContain('Commit cancelled by user');
    });

    it('fail-closes on detached HEAD (branch resolves to null)', async () => {
      grant(['main']);
      vi.mocked(ctx.core.getAuto).mockReturnValue(true);
      // `git rev-parse --abbrev-ref HEAD` prints the literal HEAD when detached.
      onBranch('HEAD');
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n', 'auto'));

      const result = await gitCommitTool.handler(ctx, { message: 'detached' });

      expect(ctx.core.question).toHaveBeenCalled();
      expect(result).toContain('auto mode is ON');
    });

    it('PLAN MODE ALWAYS WINS: no bypass even with auto+flag+listed branch', async () => {
      grant(['main']);
      vi.mocked(ctx.core.getAuto).mockReturnValue(true);
      vi.mocked(ctx.core.getMode).mockReturnValue('plan');
      onBranch('main');
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n', 'auto'));

      const result = await gitCommitTool.handler(ctx, { message: 'plan-mode commit' });

      // The flag is a capability grant, never a mode override.
      expect(ctx.core.question).toHaveBeenCalled();
      expect(result).toContain('auto mode is ON');
    });

    it('is a no-op when the flag is unset (question() still called)', async () => {
      vi.mocked(isAllowAutoCommit).mockReturnValue(false);
      vi.mocked(ctx.core.getAuto).mockReturnValue(true);
      vi.mocked(ctx.core.question).mockResolvedValueOnce(askResult('n', 'auto'));

      const result = await gitCommitTool.handler(ctx, { message: 'flag off' });

      expect(ctx.core.question).toHaveBeenCalled();
      expect(result).toContain('auto mode is ON');
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