/**
 * tmux_list.ts - List tmux sessions for current project
 *
 * Lists all tmuxSessions for the current project directory.
 * Syncs with system tmux to remove stale entries.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmuxListTool: ToolDefinition = {
  name: 'tmux_list',
  description: 'List all tmuxSessions for the current project. Shows session name, remote host (if set), and connection status.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    const projectDir = ctx.core.getWorkDir();

    // Sync with system tmux
    await ctx.tmux.syncTmuxSessions(projectDir);

    // Get sessions for this project
    const sessions = await ctx.tmux.getTmuxSessionsByProject(projectDir);

    if (sessions.length === 0) {
      return `No tmuxSessions for project: ${projectDir}\n\nUse tmux_new to create one.`;
    }

    // Get system sessions to show status
    const systemSessions = await ctx.tmux.listSystemTmuxSessions();

    // Build output
    const lines = [`tmuxSessions for project: ${projectDir}`, ''];

    for (const session of sessions) {
      const host = session.remoteHost || '(host not set)';
      const status = systemSessions.includes(session.tmuxSessionName) ? 'connected' : 'disconnected';
      const desc = session.description ? ` - ${session.description}` : '';

      lines.push(`  ${session.tmuxSessionName} → ${host} (${status})${desc}`);
    }

    lines.push('');
    lines.push('Use tmux_set_host to register remote hostname if not set.');
    lines.push('Use tmux_send to send commands, tmux_capture to see output.');

    return lines.join('\n');
  },
};