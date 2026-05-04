/**
 * bg_await.ts - Wait for background tasks to complete
 *
 * Scope: ['main', 'child'] - Available in both main and child contexts
 *
 * ESC handling: In main context, registers onNeglected callback to interrupt
 * waiting when ESC is pressed. In child context, ESC is not available.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';

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
    let interrupted = false;

    // Register ESC handler to interrupt waiting (only works in main process)
    // In child process, agentIO doesn't receive IPC neglection messages,
    // so the callback will never be triggered. But we register it anyway
    // for consistency - the timeout will still work.
    const onEsc = () => {
      interrupted = true;
    };

    // Only register if we're in main process (agentIO has been initialized)
    if (agentIO.isMainProcess()) {
      agentIO.onNeglected(onEsc);
    }

    try {
      while (elapsed < timeout && !interrupted) {
        try {
          const hasRunning = await ctx.bg.hasRunningBgTasks();

          if (!hasRunning) {
            ctx.core.brief('info', 'bg_await', `${targetDesc} completed`);
            return 'OK';
          }

          // If waiting for specific pid, check if it's still running
          if (pid !== undefined) {
            // Access the internal task map to check specific task status
            // This is a bit of a hack, but we need direct access to task status
            const bgModule = ctx.bg as unknown as { getTask: (pid: number) => { status: string } | undefined };
            const task = bgModule.getTask(pid);
            if (!task || task.status !== 'running') {
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

      if (interrupted) {
        ctx.core.brief('warn', 'bg_await', 'Interrupted by ESC');
        return 'Error: Interrupted by user';
      }

      ctx.core.brief('warn', 'bg_await', `Timeout reached, ${targetDesc} still running`);
      return 'Error: Timeout reached';
    } finally {
      // Clean up: remove the ESC handler if still in the list
      // Note: onNeglected callbacks are cleared after being called, so this is just safety
      if (agentIO.isMainProcess()) {
        const callbacks = (agentIO as unknown as { onNeglectedCallbacks: Array<() => void> }).onNeglectedCallbacks;
        const index = callbacks.indexOf(onEsc);
        if (index !== -1) {
          callbacks.splice(index, 1);
        }
      }
    }
  },
};