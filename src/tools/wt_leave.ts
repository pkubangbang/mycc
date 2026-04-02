/**
 * wt_leave.ts - Leave current worktree (return to project root)
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const wtLeaveTool: ToolDefinition = {
  name: 'wt_leave',
  description: 'Leave the current worktree and return to the project root directory.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    await ctx.wt.leaveWorkTree();
    const workDir = ctx.core.getWorkDir();
    ctx.core.brief('info', 'wt_leave', `Returned to project root: ${workDir}`);
    return `Left worktree. Working directory is now: ${workDir}`;
  },
};