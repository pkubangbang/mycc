/**
 * wt_enter.ts - Enter a git worktree (change working directory)
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const wtEnterTool: ToolDefinition = {
  name: 'wt_enter',
  description: 'Enter a git worktree by name. Changes the working directory to the worktree path.',
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

    try {
      await ctx.wt.enterWorkTree(name);
      const workDir = ctx.core.getWorkDir();
      ctx.core.brief('info', 'wt_enter', `Entered worktree '${name}' at ${workDir}`);
      return `Entered worktree '${name}'. Working directory is now: ${workDir}`;
    } catch (err) {
      ctx.core.brief('error', 'wt_enter', `Failed to enter worktree: ${(err as Error).message}`);
      return `Error: ${(err as Error).message}`;
    }
  },
};