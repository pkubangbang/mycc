/**
 * tmux_kill.ts - Kill a tmux session
 *
 * Kills the tmux session and removes it from the database.
 */

import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

export const tmuxKillTool: ToolDefinition = {
  name: 'tmux_kill',
  description: 'Kill a tmux session. Removes it from both tmux and the database.',
  input_schema: {
    type: 'object',
    properties: {
      tmuxSession: {
        type: 'string',
        description: 'The tmuxSession name to kill',
      },
    },
    required: ['tmuxSession'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const tmuxSessionName = args.tmuxSession as string;
    const projectDir = ctx.core.getWorkDir();

    // Verify session belongs to this project
    const session = await ctx.tmux.verifyTmuxSession(tmuxSessionName, projectDir);

    if (!session) {
      return `Error: tmuxSession "${tmuxSessionName}" not found in current project.`;
    }

    // Kill the tmux session
    try {
      execSync(`tmux kill-session -t "${tmuxSessionName}" 2>/dev/null`, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Session might not exist in tmux, that's okay
    }

    // Remove from database
    await ctx.tmux.deleteTmuxSession(tmuxSessionName);

    ctx.core.brief('info', 'tmux', `Killed tmuxSession: ${tmuxSessionName}`);

    return `✓ Killed tmuxSession "${tmuxSessionName}"`;
  },
};