/**
 * tm_await.ts - Wait for teammate(s) to finish
 *
 * Scope: ['main'] - Only lead agent can await teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmAwaitTool: ToolDefinition = {
  name: 'tm_await',
  description:
    'Wait for a teammate or all teammates to finish their current task. Use this instead of polling with bash sleep. Returns when the teammate(s) reach idle/shutdown state or timeout.',
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

    if (!ctx.team) {
      ctx.core.brief('error', 'tm_await', 'Team module not available');
      return 'Error: Team module not available in this context';
    }

    ctx.core.brief('info', 'tm_await', name ? `Waiting for teammate '${name}'...` : 'Waiting for all teammates...');

    try {
      if (name) {
        await ctx.team.awaitTeammate(name, timeout);
        ctx.core.brief('info', 'tm_await', `Teammate '${name}' finished`);
        return 'OK';
      } else {
        const result = await ctx.team.awaitTeam(timeout);
        ctx.core.brief('info', 'tm_await', result.allSettled ? 'All teammates finished' : 'Timeout reached');
        return 'OK';
      }
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_await', err.message);
      return `Error: ${err.message}`;
    }
  },
};