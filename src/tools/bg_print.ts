/**
 * bg_print.ts - List all background tasks
 *
 * Scope: ['main', 'child'] - Available to both lead and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgPrintTool: ToolDefinition = {
  name: 'bg_print',
  description: 'List all background tasks with status (running/completed/failed). Use to check if tasks finished before calling bg_await or to find pids for bg_remove.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext): Promise<string> => {
    if (!ctx.bg) {
      ctx.core.brief('error', 'bg_print', 'Background module not available');
      return 'Error: Background module not available in this context';
    }

    ctx.core.brief('info', 'bg_print', 'Listing all background tasks');

    try {
      const result = await ctx.bg.printBgTasks();
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'bg_print', err.message);
      return `Error: ${err.message}`;
    }
  },
};