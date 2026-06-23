/**
 * bg_print.ts - List all background tasks, or show a single task's output
 *
 * Scope: ['main', 'child'] - Available to both lead and child agents
 *
 * Without a pid: lists all tasks with status (running/completed/failed).
 * With a pid: shows the detailed view including accumulated output (tail-capped).
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgPrintTool: ToolDefinition = {
  name: 'bg_print',
  description: 'List all background tasks with status (running/completed/failed/killed), or show accumulated output for a specific task by pid. Use without pid to check overall status, or with pid to read the output (stdout+stderr) of a background command.',
  input_schema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'Optional: process ID of a specific task. When provided, returns the task detail including accumulated output (tail-capped to the most recent ~100KB). Omit to list all tasks.',
      },
    },
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    if (!ctx.bg) {
      ctx.core.brief('error', 'bg_print', 'Background module not available');
      return 'Error: Background module not available in this context';
    }

    const pid = args.pid as number | undefined;

    if (pid !== undefined) {
      ctx.core.brief('info', 'bg_print', `Showing task ${pid}`);
    } else {
      ctx.core.brief('info', 'bg_print', 'Listing all background tasks');
    }

    try {
      const result = await ctx.bg.printBgTasks(pid);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'bg_print', err.message);
      return `Error: ${err.message}`;
    }
  },
};