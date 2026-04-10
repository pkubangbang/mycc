/**
 * tmux_send.ts - Send commands to a tmux session
 *
 * Sends keys/commands to a tmux session. Requires the session to have
 * a registered remote host (set via tmux_set_host).
 */

import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

export const tmuxSendTool: ToolDefinition = {
  name: 'tmux_send',
  description: 'Send a command to a tmux session. The session must have a registered remote host (use tmux_set_host first). Shows confirmation with [session@host] before execution.',
  input_schema: {
    type: 'object',
    properties: {
      tmuxSession: {
        type: 'string',
        description: 'The tmuxSession name',
      },
      command: {
        type: 'string',
        description: 'The command to send',
      },
      enter: {
        type: 'boolean',
        description: 'Press Enter after the command (default: true)',
      },
    },
    required: ['tmuxSession', 'command'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const tmuxSessionName = args.tmuxSession as string;
    const command = args.command as string;
    const enter = (args.enter as boolean) ?? true;
    const projectDir = ctx.core.getWorkDir();

    // Verify session belongs to this project
    const session = await ctx.tmux.verifyTmuxSession(tmuxSessionName, projectDir);

    if (!session) {
      return `Error: tmuxSession "${tmuxSessionName}" not found in current project. Use tmux_list to see available sessions.`;
    }

    // Check if remote host is set
    if (!session.remoteHost) {
      return `Error: Remote host not set for tmuxSession "${tmuxSessionName}". Use tmux_set_host first:\n  tmux_set_host(tmuxSession: "${tmuxSessionName}", host: "your-hostname")`;
    }

    // Check if session still exists in tmux
    const systemSessions = await ctx.tmux.listSystemTmuxSessions();
    if (!systemSessions.includes(tmuxSessionName)) {
      await ctx.tmux.deleteTmuxSession(tmuxSessionName);
      return `Error: tmuxSession "${tmuxSessionName}" no longer exists. Create a new one with tmux_new.`;
    }

    // Build tmux send-keys command
    // Escape special characters for shell
    const escapedCommand = command.replace(/'/g, "'\"'\"'");
    let tmuxCmd = `tmux send-keys -t "${tmuxSessionName}" '${escapedCommand}'`;
    if (enter) {
      tmuxCmd += ' Enter';
    }

    try {
      execSync(tmuxCmd, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return `Error sending command to tmux: ${(err as Error).message}`;
    }

    // Update last used timestamp
    await ctx.tmux.touchTmuxSession(tmuxSessionName);

    ctx.core.brief('info', 'tmux', `Sent command to ${tmuxSessionName}: ${command}`);

    return `✓ [${tmuxSessionName}@${session.remoteHost}] sent: ${command}`;
  },
};