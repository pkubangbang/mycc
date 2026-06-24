/**
 * mail_to.ts - Send async message to a specific teammate
 *
 * Scope: ['main', 'child'] - Both lead and teammates can send mail
 *
 * When a child process sends mail to 'lead' with eta>0 (seconds from now),
 * the handler passes eta to ctx.team.mailTo(), which is handled by ChildTeam
 * to send IPC 'eta_update' to the parent so TeamManager tracks the deadline.
 */

import chalk from 'chalk';
import type { ToolDefinition, AgentContext } from '../types.js';

export const mailToTool: ToolDefinition = {
  name: 'mail_to',
  description: 'Send an async message to a teammate or "lead". Non-blocking - does not wait for response. Use for task assignment and inter-agent communication. Include meaningful content.',
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
      eta: {
        type: 'number',
        description: 'MANDATORY when a teammate sends the first (or extension) mail to lead. Estimate duration in seconds. ' +
          'Example: eta=120 means "I need about 2 minutes". The system will convert this to an absolute deadline. ' +
          'Set to 0 or omit for non-budget messages (progress updates, lead responses).',
      },
    },
    required: ['name', 'title', 'content'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const title = args.title as string;
    const content = args.content as string;
    const eta = args.eta as number | undefined;

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

    const senderName = ctx.core.getName();
    const isTeammateToLead = name === 'lead' && senderName !== 'lead';

    // Conditional enforcement: child→lead requires positive eta (seconds from now)
    if (isTeammateToLead) {
      if (eta === undefined) {
        ctx.core.brief('error', 'mail_to',
          'eta is required when sending to lead. ' +
          'Estimate how long you need in seconds (e.g., eta=120 for ~2 minutes).');
        return 'Error: eta is required when sending to lead. ' +
               'Set eta to the number of seconds you need (e.g., eta=120 for 2 minutes).';
      }
      if (typeof eta !== 'number' || !Number.isInteger(eta) || eta <= 0) {
        ctx.core.brief('error', 'mail_to',
          `eta must be a positive integer (seconds from now), got: ${eta}`);
        return 'Error: eta must be a positive integer (seconds from now). ' +
               'Example: eta=120 for about 2 minutes.';
      }

      // ctx.team.mailTo handles IPC (eta_update) in ChildTeam implementation
      ctx.core.brief('info', 'mail_to', `(...to ${name}) ${title}\n${chalk.gray(content)}`);
      ctx.team.mailTo(name, title, content, undefined, eta);
      return `OK. Budget sent to lead: ~${eta}s from now. The lead will wait until the deadline. Extend by sending mail_to with a new eta.`;
    }

    // Lead→anyone or child→other: eta is optional, mail as usual
    ctx.core.brief('info', 'mail_to', `(...to ${name}) ${title}\n${chalk.gray(content)}\n`);
    ctx.team.mailTo(name, title, content);
    return 'OK';
  },
};
