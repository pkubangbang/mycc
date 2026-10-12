/**
 * tm_await.ts - Wait for teammate(s) to finish
 *
 * Scope: ['main'] - Only lead agent can await teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmAwaitTool: ToolDefinition = {
  name: 'tm_await',
  description: 'Block until teammate(s) finish their task. Prefer NOT to use — let teammates work asynchronously. Timeout defaults to the teammate\'s ETA (from mail_to) when provided.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Teammate name to wait for; if omitted, waits for all.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default 300000 = 5 min); the teammate\'s ETA is used instead if provided.',
      },
    },
    required: [],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string | undefined;
    const timeout = (args.timeout as number) ?? 300000;

    try {
      if (name) {
        // Check if teammate exists
        const teammate = ctx.team.getTeammate(name);
        if (!teammate) {
          return `Error: Teammate '${name}' not found`;
        }

        const reason = await ctx.team.awaitTeammates({ name, timeoutMs: timeout });
        return reasonToMessage(reason);
      } else {
        const teammates = ctx.team.listTeammates();
        if (teammates.length === 0) {
          return 'No teammates to wait for. Create teammates with tm_create first.';
        }

        const reason = await ctx.team.awaitTeammates({ timeoutMs: timeout });
        return reasonToMessage(reason);
      }
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_await', err.message);
      return `Error: ${err.message}`;
    }
  },
};

/** Map a TeammateWaitReason to a user-facing message. */
function reasonToMessage(reason: string): string {
  switch (reason) {
    case 'all done':  return 'All teammates finished their work.';
    case 'holding':   return 'A teammate has a question waiting for response.';
    case 'mail':      return 'New mail arrived.';
    case 'steering':  return 'A WebUI steering note is waiting.';
    case 'esc':       return 'Wait interrupted by ESC.';
    case 'timeout':   return 'Timeout waiting for teammates to finish.';
    default:          return `Unknown result: ${reason}`;
  }
}