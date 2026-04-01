/**
 * mail_to.ts - Send async message to a specific teammate
 *
 * Scope: ['main', 'child'] - Both lead and teammates can send mail
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const mailToTool: ToolDefinition = {
  name: 'mail_to',
  description: 'Send an async message to a specific teammate. Use this for inter-agent communication.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Target teammate name to receive the message',
      },
      title: {
        type: 'string',
        description: 'Message title/subject',
      },
      content: {
        type: 'string',
        description: 'Message body content',
      },
    },
    required: ['name', 'title', 'content'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    const title = args.title as string;
    const content = args.content as string;

    // Validate required parameters
    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'mail_to', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }
    if (!title || typeof title !== 'string') {
      ctx.core.brief('error', 'mail_to', 'Missing or invalid title parameter');
      return 'Error: title parameter is required and must be a string';
    }
    if (!content || typeof content !== 'string') {
      ctx.core.brief('error', 'mail_to', 'Missing or invalid content parameter');
      return 'Error: content parameter is required and must be a string';
    }

    // Check if teammate exists
    if (!ctx.team) {
      ctx.core.brief('error', 'mail_to', 'Team module not available');
      return 'Error: Team module not available in this context';
    }

    const teammate = ctx.team.getTeammate(name);
    if (!teammate) {
      ctx.core.brief('warn', 'mail_to', `Teammate '${name}' not found`);
      return `Error: Teammate '${name}' not found`;
    }

    ctx.core.brief('info', 'mail_to', `Sending mail to ${name}: ${title}`);

    try {
      ctx.team.mailTo(name, title, content);
      return `Mail sent to '${name}' with title: ${title}`;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'mail_to', err.message);
      return `Error: ${err.message}`;
    }
  },
};