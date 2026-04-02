/**
 * wt_create.ts - Create a new git worktree
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const wtCreateTool: ToolDefinition = {
  name: 'wt_create',
  description: 'Create a new git worktree with a new branch. Returns the path to the worktree.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the worktree (used for directory name)',
      },
      branch: {
        type: 'string',
        description: 'Name of the new branch to create',
      },
    },
    required: ['name', 'branch'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const branch = args.branch as string;

    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'wt_create', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }
    if (!branch || typeof branch !== 'string') {
      ctx.core.brief('error', 'wt_create', 'Missing or invalid branch parameter');
      return 'Error: branch parameter is required and must be a string';
    }

    const result = await ctx.wt.createWorkTree(name, branch);
    ctx.core.brief('info', 'wt_create', `Created worktree '${name}' on branch ${branch}`);
    return result;
  },
};