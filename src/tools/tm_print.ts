/**
 * tm_print.ts - Print team information
 *
 * Scope: ['main', 'child'] - Both lead and teammate can view team status
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmPrintTool: ToolDefinition = {
  name: 'tm_print',
  description: 'Print current team status showing all teammates, their roles, and status (working/idle/shutdown).',
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    return await ctx.team.printTeam();
  },
};