/**
 * mail_to.ts - Send async message to a specific teammate
 *
 * Scope: ['main', 'child'] - Both lead and teammates can send mail
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const mailToTool: ToolDefinition = {
  name: 'mail_to',
  description:
    'Send an async message to a specific teammate or lead. Use this for inter-agent communication. Use "lead" to message the lead agent. ' +
    'IMPORTANT: Always include meaningful content that clearly explains the purpose of your message - avoid sending empty or placeholder content like just "lead" or "check".',
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

    // Both main and child processes use team.mailTo directly
    // In child process, this writes to mailbox file directly
    // In main process, this also writes to mailbox file
    ctx.core.brief('info', `mail_to ${name}`, `${title}\n--------------------\n${content}`);
    ctx.team!.mailTo(name, title, content);

    return `A mail to '${name}' has been sent.`;
  },
};