/**
 * tmux_new.ts - Create a new tmux session for remote SSH
 *
 * Creates a tmux session tied to the current project directory.
 * The user can then attach to it, SSH to a remote server, and detach.
 * After detaching, use tmux_set_host to register the remote hostname.
 */

import { execSync } from 'child_process';
import type { ToolDefinition, AgentContext } from '../types.js';

export const tmuxNewTool: ToolDefinition = {
  name: 'tmux_new',
  description: 'Create a new tmux session for remote SSH. The session is tied to the current project. After creation, attach with "tmux attach -t <name>", SSH to your server, then detach with Ctrl+B D. Use tmux_set_host to register the remote hostname after login.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Optional description for this tmuxSession (e.g., "production server")',
      },
    },
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const description = args.description as string | undefined;
    const projectDir = ctx.core.getWorkDir();

    // Check if tmux is installed
    if (!ctx.tmux.isTmuxInstalled()) {
      return 'Error: tmux is not installed. Install tmux first: sudo apt install tmux (or equivalent for your system)';
    }

    // Generate session name
    const sessionName = await ctx.tmux.generateTmuxSessionName(projectDir);

    // Create tmux session
    try {
      execSync(`tmux new-session -d -s "${sessionName}"`, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return `Error creating tmux session: ${(err as Error).message}`;
    }

    // Save to database
    await ctx.tmux.createTmuxSession(sessionName, projectDir, description);

    // Build output
    const lines = [
      `✓ Created tmuxSession: ${sessionName}`,
      '',
      'To connect to your remote server:',
      `  1. Run: tmux attach -t ${sessionName}`,
      '  2. SSH to your server: ssh user@host',
      '  3. After login, detach with Ctrl+B D',
      `  4. Run tmux_set_host to register the remote hostname: tmux_set_host(tmuxSession: "${sessionName}", host: "your-hostname")`,
      '',
      `This tmuxSession is bound to project: ${projectDir}`,
    ];

    ctx.core.brief('info', 'tmux', `Created tmuxSession: ${sessionName}`);

    return lines.join('\n');
  },
};