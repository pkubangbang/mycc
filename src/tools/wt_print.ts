/**
 * wt_print.ts - List all git worktrees
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const wtPrintTool: ToolDefinition = {
  name: 'wt_print',
  description: 'List all git worktrees with names, branches, and paths. Use to see available worktrees before wt_enter.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    const result = await ctx.wt.printWorkTrees();
    ctx.core.brief('info', 'wt_print', 'Listed worktrees');
    return result;
  },
};