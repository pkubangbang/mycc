/**
 * wt_leave.ts - Leave current worktree (return to project root)
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const wtLeaveTool: ToolDefinition = {
  name: 'wt_leave',
  description: 'Exit current worktree and return to project root directory. Use when done with worktree operations.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext): Promise<string> => {
    await ctx.wt.leaveWorkTree();
    const workDir = ctx.core.getWorkDir();
    ctx.core.brief('info', 'wt_leave', `Returned to project root: ${workDir}`);
    return `OK: ${workDir}`;
  },
};