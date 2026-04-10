/**
 * tmux_set_host.ts - Register the remote hostname for a tmuxSession
 *
 * After SSH login, use this tool to confirm the remote hostname.
 * This is required before tmux_send can be used.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmuxSetHostTool: ToolDefinition = {
  name: 'tmux_set_host',
  description: 'Register the remote hostname for a tmuxSession. Required before tmux_send/tmux_capture can be used. Call this after you have SSHed to the remote server and detached from the tmux session.',
  input_schema: {
    type: 'object',
    properties: {
      tmuxSession: {
        type: 'string',
        description: 'The tmuxSession name (from tmux_new)',
      },
      host: {
        type: 'string',
        description: 'The remote hostname (e.g., "api.prod.com")',
      },
    },
    required: ['tmuxSession', 'host'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const tmuxSessionName = args.tmuxSession as string;
    const host = args.host as string;
    const projectDir = ctx.core.getWorkDir();

    // Verify session belongs to this project
    const session = await ctx.tmux.verifyTmuxSession(tmuxSessionName, projectDir);

    if (!session) {
      return `Error: tmuxSession "${tmuxSessionName}" not found in current project. Use tmux_list to see available sessions.`;
    }

    // Check if session still exists in tmux
    const systemSessions = await ctx.tmux.listSystemTmuxSessions();
    if (!systemSessions.includes(tmuxSessionName)) {
      // Clean up stale record
      await ctx.tmux.deleteTmuxSession(tmuxSessionName);
      return `Error: tmuxSession "${tmuxSessionName}" no longer exists. Create a new one with tmux_new.`;
    }

    // Update remote host
    await ctx.tmux.setRemoteHost(tmuxSessionName, host);

    ctx.core.brief('info', 'tmux', `Set remote host for ${tmuxSessionName}: ${host}`);

    return `✓ Registered remote host for tmuxSession "${tmuxSessionName}": ${host}\n\nYou can now use tmux_send and tmux_capture with this session.`;
  },
};