/**
 * mail_to.ts - Send async message to a specific teammate
 *
 * Scope: ['main', 'child'] - Both lead and teammates can send mail
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { sendRequest } from '../context/child-context/ipc-helpers.js';

export const mailToTool: ToolDefinition = {
  name: 'mail_to',
  description:
    'Send an async message to a specific teammate or lead. Use this for inter-agent communication. Use "lead" to message the lead agent.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Target name to receive the message (teammate name or "lead")',
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
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
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

    // Child process: send via IPC to lead
    if (!ctx.team) {
      ctx.core.brief('info', 'mail_to', `Sending mail to ${name} via lead: ${title}`);
      try {
        // sendRequest resolves with msg.data on success, rejects on failure
        await sendRequest<{ to: string }>('send_mail', {
          to: name,
          title,
          content,
        });
        return `Mail sent to '${name}' with title: ${title}`;
      } catch (error) {
        const err = error as Error;
        ctx.core.brief('error', 'mail_to', err.message);
        return `Error: ${err.message}`;
      }
    }

    // Main process: direct access to team module
    // Sending to lead
    if (name === 'lead') {
      ctx.core.brief('info', 'mail_to', `Sending mail to lead: ${title}`);
      ctx.team.mailTo('lead', title, content);
      return `Mail sent to 'lead' with title: ${title}`;
    }

    // Check if teammate exists
    const teammate = ctx.team.getTeammate(name);
    if (!teammate) {
      const available = ctx.team
        .listTeammates()
        .map((t) => t.name)
        .join(', ') || 'none';
      ctx.core.brief('warn', 'mail_to', `Teammate '${name}' not found`);
      return `Error: Teammate '${name}' not found. Available: ${available}. Use 'lead' to message the lead agent.`;
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