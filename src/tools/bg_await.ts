/**
 * bg_await.ts - Wait for background tasks to complete
 *
 * Scope: ['main', 'child'] - Available in both main and child contexts
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgAwaitTool: ToolDefinition = {
  name: 'bg_await',
  description: 'Block until background tasks complete. Use after bg_create when you need results before proceeding. Default timeout 60 seconds.',
  input_schema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'Process ID to wait for specific task. Omit to wait for ALL background tasks to complete.',
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 60000). Increase for long-running commands.',
      },
    },
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const pid = args.pid as number | undefined;
    const timeout = (args.timeout as number) ?? 60000;

    if (!ctx.bg) {
      ctx.core.brief('error', 'bg_await', 'Background module not available');
      return 'Error: Background module not available in this context';
    }

    const startTime = Date.now();
    const targetDesc = pid ? `task ${pid}` : 'all background tasks';
    ctx.core.brief('info', 'bg_await', `Waiting for ${targetDesc} to complete...`);

    const pollInterval = 1000; // 1 second
    let elapsed = 0;

    while (elapsed < timeout) {
      try {
        const hasRunning = await ctx.bg.hasRunningBgTasks();

        if (!hasRunning) {
          ctx.core.brief('info', 'bg_await', `${targetDesc} completed`);
          return 'OK';
        }

        // If waiting for specific pid, check if it's still running
        if (pid !== undefined) {
          const tasks = await ctx.bg.printBgTasks();
          // Check if the specific pid is in the task list
          if (!tasks.includes(`[${pid}]`)) {
            ctx.core.brief('info', 'bg_await', `Task ${pid} completed`);
            return 'OK';
          }
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsed = Date.now() - startTime;
      } catch (error: unknown) {
        const err = error as Error;
        ctx.core.brief('error', 'bg_await', err.message);
        return `Error: ${err.message}`;
      }
    }

    ctx.core.brief('warn', 'bg_await', `Timeout reached, ${targetDesc} still running`);
    return 'Error: Timeout reached';
  },
};