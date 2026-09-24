/**
 * bg_await.ts - Wait for background tasks to complete
 *
 * Scope: ['main', 'child'] - Available in both main and child contexts
 *
 * THIN WRAPPER: all waiting logic (the poll loop, the ESC watch, and the
 * WebUI steering peek) lives in the bg module — `ctx.bg.waitForTasks()`, the
 * analogue of `ctx.team.awaitTeammates()`. The bg module OWNS the background
 * tasks, so it also owns the wait/watch; this tool only formats the result.
 *
 * This keeps the tool decoupled from the serve layer: it does NOT import
 * `getServeHub()` (nor agentIO) — the steering peek / ESC registration happen
 * inside the module that owns the resource, not in the tool layer. See the
 * `decoupled-ipc-bounceback` lesson.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgAwaitTool: ToolDefinition = {
  name: 'bg_await',
  description: 'Block until background tasks complete. Use after bg_create when you need results before proceeding. Default timeout 60 seconds. When waiting for a specific pid, returns the accumulated task output on completion; when waiting for all tasks, returns OK (use bg_print to inspect individual outputs).',
  input_schema: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'Process ID to wait for specific task. Omit to wait for ALL background tasks to complete.',
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default 60000). Increase for long-running commands.',
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

    const targetDesc = pid ? `task ${pid}` : 'all background tasks';
    ctx.core.brief('info', 'bg_await', `Waiting for ${targetDesc} to complete...`);

    const result = await ctx.bg.waitForTasks({ pid, timeoutMs: timeout });

    switch (result.reason) {
      case 'completed': {
        if (pid !== undefined) {
          const stateLabel = result.status === 'killed' ? 'killed' : 'completed';
          ctx.core.brief('info', 'bg_await', `Task ${pid} ${stateLabel}`);
          // Return accumulated output when available.
          if (result.output) {
            return `Task ${pid} ${stateLabel}.\n\n[output]\n${result.output}`;
          }
          return `Task ${pid} ${stateLabel} (no output).`;
        }
        ctx.core.brief('info', 'bg_await', `${targetDesc} completed`);
        return 'OK';
      }

      case 'esc':
        ctx.core.brief('warn', 'bg_await', 'Interrupted by ESC');
        return 'Error: Interrupted by user';

      case 'steering': {
        // A steering note arrived while waiting — the bg module PEEKED it
        // (did not consume). Returning early lets the state machine reach
        // COLLECT so the user's mid-task direction is honored now rather than
        // after the task finishes.
        const notes = result.notes ?? [];
        ctx.core.brief('info', 'bg_await', `Steering note received, returning to process it (${targetDesc} still running)`);
        return `OK: steering note received while waiting for ${targetDesc} (still running). `
          + `Pending direction: ${notes.map((n) => `"${n}"`).join(', ')}`;
      }

      case 'timeout':
      default:
        ctx.core.brief('warn', 'bg_await', `Timeout reached, ${targetDesc} still running`);
        return 'Error: Timeout reached';
    }
  },
};
