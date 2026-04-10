/**
 * tmux_capture.ts - Capture output from a tmux session
 *
 * Captures the visible output from a tmux session pane.
 * Requires the session to have a registered remote host.
 */

import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

export const tmuxCaptureTool: ToolDefinition = {
  name: 'tmux_capture',
  description: 'Capture visible output from a tmux session. Shows the current state of the terminal. Use after tmux_send to see command output.',
  input_schema: {
    type: 'object',
    properties: {
      tmuxSession: {
        type: 'string',
        description: 'The tmuxSession name',
      },
      lines: {
        type: 'number',
        description: 'Number of lines to capture (default: 100, max: 10000)',
      },
    },
    required: ['tmuxSession'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const tmuxSessionName = args.tmuxSession as string;
    const lines = Math.min((args.lines as number) ?? 100, 10000);
    const projectDir = ctx.core.getWorkDir();

    // Verify session belongs to this project
    const session = await ctx.tmux.verifyTmuxSession(tmuxSessionName, projectDir);

    if (!session) {
      return `Error: tmuxSession "${tmuxSessionName}" not found in current project. Use tmux_list to see available sessions.`;
    }

    // Check if remote host is set
    if (!session.remoteHost) {
      return `Error: Remote host not set for tmuxSession "${tmuxSessionName}". Use tmux_set_host first.`;
    }

    // Check if session still exists in tmux
    const systemSessions = await ctx.tmux.listSystemTmuxSessions();
    if (!systemSessions.includes(tmuxSessionName)) {
      await ctx.tmux.deleteTmuxSession(tmuxSessionName);
      return `Error: tmuxSession "${tmuxSessionName}" no longer exists.`;
    }

    // Capture pane output
    // -S -N starts N lines back from the bottom
    // -p prints to stdout
    try {
      const output = execSync(`tmux capture-pane -t "${tmuxSessionName}" -p -S -${lines}`, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      });

      // Update last used timestamp
      await ctx.tmux.touchTmuxSession(tmuxSessionName);

      ctx.core.brief('info', 'tmux', `Captured ${lines} lines from ${tmuxSessionName}`);

      const header = `[${tmuxSessionName}@${session.remoteHost}] captured ${lines} lines:\n`;
      const divider = '─'.repeat(40) + '\n';

      return header + divider + output;
    } catch (err) {
      return `Error capturing from tmux: ${(err as Error).message}`;
    }
  },
};