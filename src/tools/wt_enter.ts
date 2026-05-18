/**
 * wt_enter.ts - Enter a git worktree (change working directory)
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 *
 * For teammates not in an owned worktree, this tool asks for user confirmation
 * before entering, and sends mail notification to lead after successful entry.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';
import { MailBox } from '../context/shared/mail.js';
import { loadWorktrees } from '../context/worktree-store.js';
import * as path from 'path';

export const wtEnterTool: ToolDefinition = {
  name: 'wt_enter',
  description: 'Switch to a git worktree. Changes working directory to the worktree path. All subsequent file operations will be relative to that worktree.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the worktree to enter',
      },
    },
    required: ['name'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;

    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'wt_enter', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }

    // Check if this is a teammate (child process) not in an owned worktree
    if (!agentIO.isMainProcess()) {
      const agentName = ctx.core.getName();
      const currentDir = ctx.core.getWorkDir();
      const worktrees = loadWorktrees();
      const ownedWorktree = worktrees.find(wt => wt.name === agentName);

      // Check if we're already in an owned worktree
      const isInOwnedWorktree = ownedWorktree &&
        (currentDir === ownedWorktree.path || currentDir.startsWith(ownedWorktree.path + path.sep));

      if (!isInOwnedWorktree) {
        // Ask for confirmation before entering
        const prompt = `Teammate '${agentName}' wants to enter worktree '${name}'. Proceed? [y/N]`;
        const response = await ctx.core.question(prompt, ctx.core.getName());

        // Parse response - only 'y' or 'yes' grants permission
        let normalized = response.trim().toLowerCase();
        if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
            (normalized.startsWith("'") && normalized.endsWith("'"))) {
          normalized = normalized.slice(1, -1).trim();
        }
        const granted = normalized === 'y' || normalized === 'yes';

        if (!granted) {
          ctx.core.brief('warn', 'wt_enter', 'Worktree entry cancelled by the user.');
          return 'Worktree entry cancelled by the user. You may work on the current branch directly';
        }
      }
    }

    try {
      await ctx.wt.enterWorkTree(name);
      const workDir = ctx.core.getWorkDir();
      ctx.core.brief('info', 'wt_enter', `Entered worktree '${name}' at ${workDir}`);

      // Send mail notification to lead (for teammates)
      if (!agentIO.isMainProcess()) {
        const agentName = ctx.core.getName();
        const mail = new MailBox('lead');
        mail.appendMail(
          agentName,
          'Worktree Update',
          `Teammate '${agentName}' entered worktree '${name}' at ${workDir}`
        );
      }

      return `OK: ${workDir}`;
    } catch (err) {
      ctx.core.brief('error', 'wt_enter', `Failed to enter worktree: ${(err as Error).message}`);
      return `Error: ${(err as Error).message}`;
    }
  },
};