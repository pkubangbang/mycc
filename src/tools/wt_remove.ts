/**
 * wt_remove.ts - Remove a git worktree
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const wtRemoveTool: ToolDefinition = {
  name: 'wt_remove',
  description: 'Remove a git worktree by name.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the worktree to remove',
      },
    },
    required: ['name'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;

    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'wt_remove', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }

    await ctx.wt.removeWorkTree(name);
    ctx.core.brief('info', 'wt_remove', `Removed worktree '${name}'`);
    return `Removed worktree '${name}'`;
  },
};