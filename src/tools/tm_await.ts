/**
 * tm_await.ts - Wait for teammate(s) to finish
 *
 * Scope: ['main'] - Only lead agent can await teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmAwaitTool: ToolDefinition = {
  name: 'tm_await',
  description: 'Block until teammate(s) finish their task. Prefer NOT to use - let teammates work asynchronously. Only needed when results are required before proceeding.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Teammate name to wait for. If omitted, waits for all teammates.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 60000)',
      },
    },
    required: [],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string | undefined;
    const timeout = (args.timeout as number) ?? 60000;

    try {
      if (name) {
        // Check if teammate exists
        const teammate = ctx.team.getTeammate(name);
        if (!teammate) {
          return `Error: Teammate '${name}' not found`;
        }

        const result = await ctx.team.awaitTeammate(name, timeout);
        return result.waited ? 'OK' : 'OK (already idle)';
      } else {
        const teammates = ctx.team.listTeammates();
        if (teammates.length === 0) {
          return 'No teammates to wait for. Create teammates with tm_create first.';
        }

        const result = await ctx.team.awaitTeam(timeout);
        return result.allSettled ? 'OK' : 'OK (timeout)';
      }
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_await', err.message);
      return `Error: ${err.message}`;
    }
  },
};