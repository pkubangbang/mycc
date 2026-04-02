/**
 * bg_await.ts - Wait for background tasks to complete
 *
 * Scope: ['main', 'child'] - Available in both main and child contexts
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgAwaitTool: ToolDefinition = {
  name: 'bg_await',
  description:
    'Wait for background tasks to complete. Use this to block until all background tasks finish or timeout.',
  input_schema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'Optional process ID to wait for specific task. If omitted, waits for all tasks.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 60000)',
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
          return `All background tasks completed`;
        }

        // If waiting for specific pid, check if it's still running
        if (pid !== undefined) {
          const tasks = await ctx.bg.printBgTasks();
          // Check if the specific pid is in the task list
          if (!tasks.includes(`[${pid}]`)) {
            ctx.core.brief('info', 'bg_await', `Task ${pid} completed`);
            return `Task ${pid} completed`;
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
    const tasks = await ctx.bg.printBgTasks();
    return `Timeout reached after ${timeout}ms. Tasks still running:\n${tasks}`;
  },
};