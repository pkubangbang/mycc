/**
 * bg_await.ts - Wait for background tasks to complete
 *
 * Scope: ['main', 'child'] - Available in both main and child contexts
 *
 * ESC handling: In main context, registers onNeglected callback to interrupt
 * waiting when ESC is pressed. In child context, ESC is not available.
 *
 * Steering handling: In main context, the poll loop also PEEKS the WebUI
 * steering queue (getServeHub().getSteeringNotes()) so a mid-task direction
 * from the user breaks the wait immediately, exactly like AWAIT's
 * awaitTeammates does. Without this, a steering note queued while the agent
 * blocks in bg_await is not honored until the tool returns and the state
 * machine next reaches COLLECT — the note sits buffered the whole time.
 * Peek only (non-consuming): the drain stays a single consumption point at
 * COLLECT's 2c block. When a note is seen we return early so the loop
 * proceeds to COLLECT and drains it.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';
import { getServeHub } from '../serve/serve-registry.js';

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
    let steered = false;

    // Register ESC handler to interrupt waiting (only works in main process)
    // In child process, agentIO doesn't receive IPC neglection messages,
    // so the callback will never be triggered. But we register it anyway
    // for consistency - the timeout will still work.
    const onEsc = () => {
      interrupted = true;
    };

    // Only register if we're in main process (agentIO has been initialized)
    let unsubscribe: (() => void) | undefined;
    if (agentIO.isMainProcess()) {
      unsubscribe = agentIO.onNeglected(onEsc);
    }

    try {
      while (elapsed < timeout && !interrupted && !steered) {
        try {
          // WebUI steering note queued by the user (mid-task direction). PEEK
          // only (non-consuming) — the drain happens downstream in COLLECT's
          // 2c block, keeping a single consumption point. When a note is
          // present, break the wait so the loop proceeds to COLLECT and
          // honors the user's direction instead of blocking on the task.
          // Guarded by isRunning() so a non-serve session (no WebUI) never
          // blocks; mirrors awaitTeammates in team.ts.
          if (getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0) {
            steered = true;
            break;
          }

          if (pid !== undefined) {
            // Waiting for a specific pid: check just that task (no redundant full scan)
            const task = ctx.bg.getTask(pid);
            if (!task || task.status !== 'running') {
              const stateLabel = task?.status === 'killed' ? 'killed' : 'completed';
              ctx.core.brief('info', 'bg_await', `Task ${pid} ${stateLabel}`);
              // Return accumulated output when available (Fix 4)
              if (task?.output) {
                return `Task ${pid} ${stateLabel}.\n\n[output]\n${task.output}`;
              }
              return `Task ${pid} ${stateLabel} (no output).`;
            }
          } else {
            // Waiting for ALL tasks: check if any are still running
            const hasRunning = await ctx.bg.hasRunningBgTasks();
            if (!hasRunning) {
              ctx.core.brief('info', 'bg_await', `${targetDesc} completed`);
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

      // A steering note arrived while waiting — return early WITHOUT consuming
      // it (COLLECT's 2c block drains it next). Returning here lets the state
      // machine reach COLLECT so the user's mid-task direction is honored now
      // rather than after the task finishes.
      if (steered) {
        const notes = getServeHub().getSteeringNotes();
        ctx.core.brief('info', 'bg_await', `Steering note received, returning to process it (${targetDesc} still running)`);
        return `OK: steering note received while waiting for ${targetDesc} (still running). `
          + `Pending direction: ${notes.map((n) => `"${n}"`).join(', ')}`;
      }

      ctx.core.brief('warn', 'bg_await', `Timeout reached, ${targetDesc} still running`);
      return 'Error: Timeout reached';
    } finally {
      // Clean up: remove the ESC handler if still registered
      if (unsubscribe) {
        unsubscribe();
      }
    }
  },
};