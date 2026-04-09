/**
 * broadcast.ts - Send message to all teammates
 *
 * Scope: ['main'] - Only lead agent can broadcast
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const broadcastTool: ToolDefinition = {
  name: 'broadcast',
  description: 'Send a message to all teammates at once. Use this for announcements or coordinating team-wide updates.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Message title/subject',
      },
      content: {
        type: 'string',
        description: 'Message body content',
      },
    },
    required: ['title', 'content'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const title = args.title as string;
    const content = args.content as string;

    // Validate required parameters
    if (!title || typeof title !== 'string') {
      ctx.core.brief('error', 'broadcast', 'Missing or invalid title parameter');
      return 'Error: title parameter is required and must be a string';
    }
    if (!content || typeof content !== 'string') {
      ctx.core.brief('error', 'broadcast', 'Missing or invalid content parameter');
      return 'Error: content parameter is required and must be a string';
    }

    const teammates = ctx.team.listTeammates();
    if (teammates.length === 0) {
      ctx.core.brief('warn', 'broadcast', 'No teammates to broadcast to');
      return 'Warning: No teammates available to receive broadcast';
    }

    ctx.core.brief('info', 'broadcast', `Broadcasting to ${teammates.length} teammate(s): ${title}`);

    try {
      ctx.team.broadcast(title, content);
      return 'OK';
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'broadcast', err.message);
      return `Error: ${err.message}`;
    }
  },
};