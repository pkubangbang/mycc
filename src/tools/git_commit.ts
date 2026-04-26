/**
 * git_commit.ts - Execute git commit with mandatory user permission
 *
 * Scope: ['main', 'child'] - Available to all agents
 *
 * This tool enforces the "ask before commit" rule by:
 * 1. Asking user for permission via ctx.core.question()
 * 2. Only executing git commit if user grants permission
 * 3. Rejecting if user denies
 *
 * Parameters:
 * - message: The commit message (required)
 * - amend: Whether to amend the previous commit (optional, default false)
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: `Execute git commit with mandatory user permission check.
This tool ALWAYS asks for user permission before committing.

Use this tool for ALL git commits. Never use 'bash' with 'git commit' - that is blocked.

Parameters:
- message: The commit message (required)
- amend: Set to true to amend the previous commit (optional, default false)

The tool will:
1. Show the commit message to the user
2. Ask for permission with [y/N] prompt
3. Only commit if user types 'y' or 'yes'
4. Return the commit result or cancellation message`,
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
    },
    required: ['message'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const message = args.message as string;
    const amend = args.amend === true;

    // Validate message parameter
    if (!message || typeof message !== 'string' || message.trim() === '') {
      return 'Error: The "message" parameter is required and must be a non-empty string';
    }

    // Check if there are staged changes before asking for permission
    try {
      const { stdout: statusOutput } = await agentIO.exec({
        cwd: ctx.core.getWorkDir(),
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

    // Ask for user permission
    const prompt = amend
      ? `Amend commit with message: "${message}"? [y/N]`
      : `Commit with message: "${message}"? [y/N]`;

    const response = await ctx.core.question(prompt, ctx.core.getName());

    // Parse response - only 'y' or 'yes' (case-insensitive) grants permission
    const normalized = response.trim().toLowerCase();
    const granted = normalized === 'y' || normalized === 'yes';

    if (!granted) {
      ctx.core.brief('info', 'git_commit', 'Commit cancelled by user');
      return 'Commit cancelled by user';
    }

    // User granted permission - execute the commit
    ctx.core.brief('info', 'git_commit', 'Permission granted, executing commit');

    const command = amend
      ? `git commit --amend -m "${message.replace(/"/g, '\\"')}"`
      : `git commit -m "${message.replace(/"/g, '\\"')}"`;

    try {
      const { stdout, stderr, interrupted, exitCode, timedOut } = await agentIO.exec({
        cwd: ctx.core.getWorkDir(),
        command,
        timeout: 30,
      });

      if (timedOut) {
        ctx.core.brief('error', 'git_commit', 'Commit timed out after 30 seconds');
        return 'Error: Commit timed out after 30 seconds';
      }

      if (interrupted) {
        ctx.core.brief('warn', 'git_commit', 'Commit interrupted by user');
        return 'Commit interrupted by user';
      }

      // Build result
      const parts: string[] = [];

      if (exitCode === 0) {
        ctx.core.brief('info', 'git_commit', 'Commit successful');
        parts.push('Commit successful');
        if (stdout.trim()) {
          parts.push(`[stdout]\n${stdout.trim()}`);
        }
      } else {
        ctx.core.brief('error', 'git_commit', `Commit failed (exit: ${exitCode})`);
        parts.push(`Commit failed (exit: ${exitCode})`);
        if (stderr.trim()) {
          parts.push(`[stderr]\n${stderr.trim()}`);
        }
      }

      return parts.join('\n\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      ctx.core.brief('error', 'git_commit', `Error executing commit: ${errorMessage}`);
      return `Error executing commit: ${errorMessage}`;
    }
  },
};