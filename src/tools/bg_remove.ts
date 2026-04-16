/**
 * bg_remove.ts - Kill a background task by its process ID
 *
 * Scope: ['main', 'child'] - Available in both main and child processes
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgRemoveTool: ToolDefinition = {
  name: 'bg_remove',
  description: 'Terminate a background task by pid. Use when a background task is stuck or no longer needed. Get pid from bg_create result or bg_print output.',
  input_schema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'Process ID of the background task to kill. Obtain from bg_create result or bg_print output.',
      },
    },
    required: ['pid'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const pid = args.pid as number;

    // Validate required parameters
    if (pid === undefined || pid === null || typeof pid !== 'number' || !Number.isInteger(pid)) {
      ctx.core.brief('error', 'bg_remove', 'Missing or invalid pid parameter');
      return 'Error: pid parameter is required and must be a valid integer';
    }

    // Check if bg module is available
    if (!ctx.bg) {
      ctx.core.brief('error', 'bg_remove', 'Background module not available');
      return 'Error: Background module not available in this context';
    }

    ctx.core.brief('info', 'bg_remove', `Killing background task with PID ${pid}`);

    try {
      await ctx.bg.killTask(pid);
      return 'OK';
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'bg_remove', err.message);
      return `Error: ${err.message}`;
    }
  },
};