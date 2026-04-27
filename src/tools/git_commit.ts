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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

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
3. If user types 'y' or 'yes': execute the commit
4. If user types 'n' or 'no': cancel the commit
5. Otherwise: return the user's response for LLM to iterate (e.g., user feedback on message)`,
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
    // Strip surrounding quotes (tmux send-keys may add them)
    let normalized = response.trim().toLowerCase();
    if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))) {
      normalized = normalized.slice(1, -1).trim();
    }
    const granted = normalized === 'y' || normalized === 'yes';
    const denied = normalized === 'n' || normalized === 'no';

    // If explicitly denied, cancel the commit
    if (denied) {
      ctx.core.brief('info', 'git_commit', 'Commit cancelled by user');
      return 'Commit cancelled by user';
    }

    // If neither granted nor denied, return the response for LLM to iterate
    // This allows user to provide feedback like "add more details" or "change the message"
    if (!granted) {
      ctx.core.brief('info', 'git_commit', `User responded: "${response}"`);
      return `User did not confirm the commit. User's response: "${response}"\n\nPlease consider the user's feedback and try again with a modified commit message if appropriate, or ask for clarification.`;
    }

    // User granted permission - execute the commit
    ctx.core.brief('info', 'git_commit', 'Permission granted, executing commit');

    // Use a temp file for the commit message to avoid shell escaping issues
    // This works reliably across all platforms (Windows cmd, PowerShell, bash)
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `git-commit-msg-${Date.now()}.txt`);

    try {
      // Write message to temp file
      fs.writeFileSync(tempFile, message, 'utf-8');

      // On Windows, cmd.exe needs special handling for paths
      // Use forward slashes which git understands, avoiding quote issues
      const gitPath = process.platform === 'win32'
        ? tempFile.replace(/\\/g, '/')
        : tempFile;

      // Build command - use spawn directly to avoid shell quoting issues
      const args = amend
        ? ['commit', '--amend', '-F', gitPath]
        : ['commit', '-F', gitPath];

      // Use spawn directly to avoid cmd.exe quote issues
      const proc = spawn('git', args, { cwd: ctx.core.getWorkDir() });

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
        parts.push('Commit successful');
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
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  },
};