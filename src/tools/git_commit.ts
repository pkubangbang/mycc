/**
 * git_commit.ts - Execute git commit with mandatory user permission
 *
 * Scope: ['main', 'child'] - Available to all agents
 *
 * This tool enforces the "ask before commit" rule by:
 * 1. Checking if teammate is in a worktree (only worktree owners can commit)
 * 2. Asking user for permission via ctx.core.question()
 * 3. Only executing git commit if user grants permission
 * 4. Rejecting if user denies
 *
 * For teammates NOT in a worktree, the tool sends mail to lead instead of committing.
 *
 * Parameters:
 * - message: The commit message (required)
 * - amend: Whether to amend the previous commit (optional, default false)
 * - cwd: Working directory for the git commit (optional, e.g. a worktree path
 *   like ".worktrees/feat"). If omitted, uses the agent's current working
 *   directory.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import type { Core } from '../context/parent/core.js';
import { agentIO } from '../loop/agent-io.js';
import { MailBox } from '../context/shared/mail.js';
import { findWorktreeByName } from '../context/worktree-store.js';
import { isAllowAutoCommit, getAllowAutoCommitBranches } from '../config.js';
import path from 'path';
import { spawn } from 'child_process';

/**
 * Resolve the current git branch short name for `cwd`.
 *
 * Uses the existing `agentIO.exec` primitive (the same one the staged-changes
 * check below already relies on) rather than spawning its own child — no new
 * subprocess abstraction.
 *
 * Returns null when the command fails or the repo is in a detached-HEAD state
 * (`git rev-parse --abbrev-ref HEAD` prints the literal `HEAD`). A null branch
 * is treated as "not allow-listed" by the caller, so a detached HEAD
 * fail-CLOSES to the interactive question() path.
 */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await agentIO.exec({
      cwd,
      command: 'git rev-parse --abbrev-ref HEAD',
      timeout: 5,
    });
    const branch = stdout.trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: `Execute git commit with mandatory user permission check. Always use this tool instead of 'bash' for git commits — bash git commit is blocked. The cwd parameter supports committing inside a specific git worktree.`,
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The commit message',
      },
      amend: {
        type: 'boolean',
        description: 'Set to true to amend the previous commit (optional, default false)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the git commit (e.g., a worktree path like ".worktrees/feat"). If omitted, uses the agent\'s current working directory.',
      },
    },
    required: ['message'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const message = args.message as string;
    const amend = args.amend === true;
    const cwdArg = args.cwd as string | undefined;

    // Validate message parameter
    if (!message || typeof message !== 'string' || message.trim() === '') {
      return 'Error: The "message" parameter is required and must be a non-empty string';
    }

    // Determine the working directory for git operations.
    // Default to the agent's workDir; allow override via `cwd` (e.g., a worktree).
    let commitCwd = cwdArg || ctx.core.getWorkDir();

    // Resolve relative cwd against the agent workDir so the lead can pass
    // ".worktrees/feat" and have it resolve against the project root.
    if (!path.isAbsolute(commitCwd)) {
      commitCwd = path.resolve(ctx.core.getWorkDir(), commitCwd);
    }

    // Check if this is a child process (teammate) without a worktree
    // Teammates can only commit if they are in a dedicated worktree
    if (!agentIO.isMainProcess()) {
      const agentName = ctx.core.getName();

      // Query git worktrees and check if this agent owns one (by name convention)
      const ownedWorktree = await findWorktreeByName(agentName, ctx.core.getWorkDir());

      // Check if we're committing inside a worktree owned by this agent
      const isInOwnedWorktree = ownedWorktree &&
        (commitCwd === ownedWorktree.path || commitCwd.startsWith(ownedWorktree.path + path.sep));

      if (!isInOwnedWorktree) {
        // Not in a worktree - send mail to lead instead of committing
        const mail = new MailBox('lead');
        mail.appendMail(
          agentName,
          'Git Commit Request',
          [
            `I would like to make a git commit:`,
            ``,
            `**Message:** ${message}`,
            amend ? `**Amend:** true` : '',
            ``,
            `Since I'm not in a dedicated worktree, I cannot commit directly.`,
            `Please review and commit on my behalf if appropriate.`,
            ``,
            `To commit for me, you can use:`,
            amend ? `\`git commit --amend -m "${message}"\`` : `\`git commit -m "${message}"\``,
          ].filter(Boolean).join('\n')
        );

        ctx.core.brief('info', 'git_commit', `Commit request sent to lead via mail`);
        return `Not in a dedicated worktree. Commit request has been sent to the lead via mail.\n\nThe lead will review and commit on your behalf. Check your mail for responses.`;
      }
    }

    // Check if there are staged changes before asking for permission
    try {
      const { stdout: statusOutput } = await agentIO.exec({
        cwd: commitCwd,
        command: 'git status --porcelain',
        timeout: 5,
      });
      
      // Check if anything is staged (lines starting with letters in first column)
      const hasStaged = statusOutput.split('\n').some(line => 
        line.length > 0 && line[0] !== ' ' && line[0] !== '?'
      );
      
      if (!hasStaged && !amend) {
        ctx.core.brief('warn', 'git_commit', 'No staged changes to commit');
        return 'Error: No staged changes to commit. Use `git add` to stage changes first.';
      }
    } catch {
      // If git status fails, just proceed - the commit will fail with a clear message
    }

    // ── Auto-commit pre-authorization (--allow-auto-commit=<branches>) ──
    // When the operator pre-authorized a branch list AND we are in auto mode
    // AND we are NOT in plan mode AND the current branch is allow-listed,
    // skip the interactive question() (which auto mode would otherwise
    // auto-DENY) and commit directly with an audit trailer.
    //
    // This mirrors plan_off.ts's shape: the getAuto() check runs BEFORE
    // question() decides whether to skip it entirely, so there is no
    // AskResult.source to read — do NOT convert this to the source==='auto'
    // pattern used further below.
    //
    // PLAN MODE ALWAYS WINS: the flag is a capability grant, never a mode
    // override. A plan-mode agent must not be able to land a commit even with
    // a pre-staged tree, so getMode()==='plan' short-circuits the bypass and
    // falls through to question() (which auto mode denies).
    //
    // Placed AFTER the child/worktree gate (a teammate in its own worktree can
    // never inherit the lead's grant — belt-and-suspenders on top of child
    // getAuto() being hard-false) and AFTER the staged-changes check above.
    const core = ctx.core as Core;
    let autoApproved = false;
    // Captured ONCE and reused for the audit trailer, so the branch recorded in
    // `Auto-Commit-Branch:` is exactly the branch that authorized the commit —
    // re-running `git rev-parse` later could observe a switched branch (TOCTOU)
    // and make the audit trail lie.
    let autoCommitBranch: string | null = null;
    if (isAllowAutoCommit() && ctx.core.getAuto() && core.getMode() !== 'plan') {
      const branch = await currentBranch(commitCwd);
      if (branch !== null && getAllowAutoCommitBranches().includes(branch)) {
        autoApproved = true;
        autoCommitBranch = branch;
        ctx.core.brief(
          'info',
          'git_commit',
          `Auto-approved commit on allow-listed branch '${branch}' (--allow-auto-commit)`,
        );
      } else {
        // Flag is set but this branch isn't listed (or detached HEAD): fall
        // through to the normal path, which auto-denies under auto mode.
        ctx.core.brief(
          'info',
          'git_commit',
          `--allow-auto-commit set but branch '${branch ?? '(detached)'}' is not allow-listed`,
        );
      }
    }

    // Ask for user permission (skipped when the auto-commit grant applied).
    const prompt = amend
      ? `Amend commit with message:\n\n  "${message}"\n\nProceed? [y/N]`
      : `Commit with message:\n\n  "${message}"\n\nProceed? [y/N]`;

    if (autoApproved) {
      // No prompt: the operator pre-authorized this branch at launch time.
      // (Deliberately not an `else`-assigned variable — see the plan_off.ts
      // precedent: the getAuto() check runs BEFORE question(), so there is no
      // AskResult to inspect here.)
      ctx.core.brief('info', 'git_commit', 'Permission granted, executing commit');
    } else {
      const { answer: response, source } = await ctx.core.question(prompt, ctx.core.getName(), { onEsc: 'n' });

      // Parse response - only 'y' or 'yes' (case-insensitive) grants permission
      // Strip surrounding quotes (tmux send-keys may add them)
      let normalized = response.trim().toLowerCase();
      if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
          (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1).trim();
      }
      const granted = normalized === 'y' || normalized === 'yes';
      // [y/N] convention means Enter = No (decline). Empty/whitespace response
      // cancels the commit, consistent with plan_off.ts's default-on-Enter
      // behavior. Without this, an empty response falls through to the
      // "partial feedback" branch and reports a confusing 'User responded: ""'.
      const denied = normalized === '' || normalized === 'n' || normalized === 'no';

      // If explicitly denied, cancel the commit
      if (denied) {
        // Auto mode: question() returns the onEsc default ('n') without user
        // input, so "denied" here is an auto-rejection, not a real user "No".
        // source === 'auto' is false for child processes, so teammates (which
        // route via mail above) are unaffected — this only triggers for the
        // lead in auto mode.
        if (source === 'auto') {
          ctx.core.brief('info', 'git_commit', 'Commit auto-rejected (auto mode is on)');
          return 'Commit was auto-rejected because auto mode is ON — the user was not asked. '
            + 'To proceed with the commit, ask the user to exit auto mode (press ESC) and then retry the git_commit.';
        }
        ctx.core.brief('info', 'git_commit', 'Commit cancelled by user');
        return 'Commit cancelled by user';
      }

      // If neither granted nor denied, return the response for LLM to iterate
      // This is a PARTIAL commit — user provided feedback instead of y/n
      // Example: "refine commit message" or "commit all"
      if (!granted) {
        ctx.core.brief('info', 'git_commit', `User responded: "${response}"`);
        return `User did not confirm the commit. User's response: "${response}"\n\nPlease consider the user's feedback and try again with a modified commit message if appropriate, or ask for clarification.`;
      }

      // User granted permission — fall through to the execution path below.
      ctx.core.brief('info', 'git_commit', 'Permission granted, executing commit');
    }

    // Append the audit trailer when the commit was auto-approved, so CI and
    // humans can see it was machine-approved rather than human-confirmed.
    // Uses the branch captured at authorization time (see autoCommitBranch).
    const commitMessage = autoApproved
      ? `${message}\n\nAuto-Committed-By: mycc --allow-auto-commit\nAuto-Commit-Branch: ${autoCommitBranch}`
      : message;

    try {
      // Use stdin (`git commit -F -`) instead of a temp file for the commit
      // message. This eliminates the temp-file leak on SIGKILL (the `finally`
      // cleanup block doesn't run on SIGKILL) and the shell-escaping concerns
      // of a file path — git reads the message directly from stdin.
      const args = amend
        ? ['commit', '--amend', '-F', '-']
        : ['commit', '-F', '-'];

      // Use spawn directly to avoid cmd.exe quote issues
      const proc = spawn('git', args, { cwd: commitCwd });

      // Write commit message to stdin
      proc.stdin?.write(commitMessage, 'utf-8');
      proc.stdin?.end();

      // Collect output
      const stdoutBuffer: Buffer[] = [];
      const stderrBuffer: Buffer[] = [];
      proc.stdout?.on('data', (chunk: Buffer) => stdoutBuffer.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrBuffer.push(chunk));

      // Wait for completion with timeout
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve({ code: 137, stdout: '', stderr: 'Timeout' });
        }, 30000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({
            code: code ?? 1,
            stdout: Buffer.concat(stdoutBuffer).toString('utf-8'),
            stderr: Buffer.concat(stderrBuffer).toString('utf-8'),
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: 1, stdout: '', stderr: err.message });
        });
      });

      const { stdout, stderr, exitCode, timedOut } = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        timedOut: result.code === 137,
      };

      if (timedOut) {
        ctx.core.brief('error', 'git_commit', 'Commit timed out after 30 seconds');
        return 'Error: Commit timed out after 30 seconds';
      }

      // Build result
      const parts: string[] = [];

      if (exitCode === 0) {
        ctx.core.brief('info', 'git_commit', 'Commit successful');

        // Check for remaining unstaged changes (partial commit)
        let hasRemainingChanges = false;
        try {
          const { stdout: statusAfter } = await agentIO.exec({
            cwd: commitCwd,
            command: 'git status --porcelain',
            timeout: 5,
          });
          hasRemainingChanges = statusAfter.trim().length > 0;
        } catch {
          // If status check fails, assume no remaining changes
        }

        if (hasRemainingChanges) {
          // Partial commit — there are still unstaged/uncommitted files
          ctx.core.brief('info', 'git_commit', 'Uncommitted changes remain — continue working');
          parts.push('Commit successful — however, there are still uncommitted changes remaining (partial commit).');
          parts.push('Continue working: stage and commit the remaining files, or inform the user about what was committed and what still needs attention.');
        } else {
          // Full commit — everything is committed
          parts.push('Commit successful');
          parts.push('Reply concisely to inform the user.');
        }
        if (stdout.trim()) {
          parts.push(`[stdout]\n${stdout.trim()}`);
        }
      } else {
        // Include error details in brief for visibility
        const errorDetail = stderr.trim() || stdout.trim() || 'No error message';
        const briefMsg = `Commit failed (exit: ${exitCode}): ${errorDetail.split('\n')[0]}`;
        ctx.core.brief('error', 'git_commit', briefMsg);
        parts.push(`Commit failed (exit: ${exitCode})`);
        if (stderr.trim()) {
          parts.push(`[stderr]\n${stderr.trim()}`);
        }
        if (stdout.trim()) {
          parts.push(`[stdout]\n${stdout.trim()}`);
        }
      }

      return parts.join('\n\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      ctx.core.brief('error', 'git_commit', `Error executing commit: ${errorMessage}`);
      return `Error executing commit: ${errorMessage}`;
    }
    // No finally block needed — git commit -F - reads the message from stdin,
    // so there is no temp file to clean up (eliminates the SIGKILL leak).
  },
};