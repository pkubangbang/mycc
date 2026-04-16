/**
 * order.ts - Send an order (task) to a teammate and wait for completion
 *
 * Combines mail_to + tm_await into one explicit blocking operation.
 * Use when you need results before proceeding.
 *
 * Scope: ['main'] - Only lead agent can order teammates
 */

import chalk from 'chalk';
import type { ToolDefinition, AgentContext } from '../types.js';

export const orderTool: ToolDefinition = {
  name: 'order',
  description: 'Send an order (task) to a teammate and wait for completion. ' +
    'Use this when you need results before proceeding. ' +
    'This combines mail_to + tm_await - sends task and blocks until teammate finishes.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Teammate name to send the order to',
      },
      title: {
        type: 'string',
        description: 'Order title - brief summary of the task',
      },
      content: {
        type: 'string',
        description: 'Detailed task description - what to do, deliverables expected',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 60000)',
      },
    },
    required: ['name', 'title', 'content'],
  },
  scope: ['main'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const title = args.title as string;
    const content = args.content as string;
    const timeout = (args.timeout as number) ?? 60000;

    // Validate required parameters
    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'order', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }
    if (!title || typeof title !== 'string') {
      ctx.core.brief('error', 'order', 'Missing or invalid title parameter');
      return 'Error: title parameter is required and must be a string';
    }
    if (!content || typeof content !== 'string') {
      ctx.core.brief('error', 'order', 'Missing or invalid content parameter');
      return 'Error: content parameter is required and must be a string';
    }

    // Verify teammate exists
    const teammate = ctx.team.getTeammate(name);
    if (!teammate) {
      ctx.core.brief('error', 'order', `Teammate '${name}' not found`);
      return `Error: Teammate '${name}' not found. Create with tm_create first.`;
    }

    // Send order and wait
    ctx.team.mailTo(name, title, content);
    ctx.core.brief('info', 'order', `to ${name}: ${title} ${chalk.gray(`(waiting ${timeout}ms)`)}`, content);

    try {
      await ctx.team.awaitTeammate(name, timeout);

      const finalStatus = ctx.team.getTeammate(name)?.status || 'unknown';

      if (finalStatus === 'idle') {
        return `Order completed. ${name} finished the task and is now idle.`;
      } else if (finalStatus === 'holding') {
        return `Order completed with question. ${name} has a question - check mail and answer it.`;
      } else if (finalStatus === 'working') {
        return `Timeout after ${timeout}ms. ${name} is still working. Options: wait longer (increase timeout), check progress with tm_print, or continue with other tasks.`;
      }
      return `Order finished. ${name} status: ${finalStatus}`;
    } catch (error: unknown) {
      const err = error as Error;
      const currentStatus = ctx.team.getTeammate(name)?.status || 'unknown';

      if (err.message.includes('Timeout')) {
        ctx.core.brief('warn', 'order', `Timeout after ${timeout}ms, ${name} is ${currentStatus}`);
        return `Timeout after ${timeout}ms. ${name} is ${currentStatus}. ` +
          `Options: call order again with longer timeout, check status with tm_print, or continue with other tasks.`;
      }
      ctx.core.brief('error', 'order', err.message);
      return `Error: ${err.message}`;
    }
  },
};