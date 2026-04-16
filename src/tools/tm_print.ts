/**
 * tm_print.ts - Print team information
 *
 * Scope: ['main', 'child'] - Both lead and teammate can view team status
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmPrintTool: ToolDefinition = {
  name: 'tm_print',
  description: 'List all teammates with roles and status (working/idle/shutdown). Use to check availability before assigning work via mail_to.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, _args: Record<string, unknown>): Promise<string> => {
    return await ctx.team.printTeam();
  },
};