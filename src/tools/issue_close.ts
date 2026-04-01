/**
 * issue_close.ts - Close an issue with a final status
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueCloseTool: ToolDefinition = {
  name: 'issue_close',
  description: 'Close an issue with a final status (completed, failed, or abandoned). Optionally add a closing comment.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'ID of the issue to close',
      },
      status: {
        type: 'string',
        enum: ['completed', 'failed', 'abandoned'],
        description: 'Final status for the issue',
      },
      comment: {
        type: 'string',
        description: 'Optional closing comment',
      },
      poster: {
        type: 'string',
        description: 'Name of the person closing the issue (optional)',
      },
    },
    required: ['id', 'status'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const id = args.id as number;
    const status = args.status as 'completed' | 'failed' | 'abandoned';
    const comment = args.comment as string | undefined;
    const poster = args.poster as string | undefined;

    if (typeof id !== 'number' || !Number.isInteger(id)) {
      ctx.core.brief('error', 'issue_close', 'Invalid id parameter');
      return 'Error: id must be an integer';
    }

    const validStatuses = ['completed', 'failed', 'abandoned'];
    if (!validStatuses.includes(status)) {
      ctx.core.brief('error', 'issue_close', `Invalid status: ${status}`);
      return `Error: status must be one of: ${validStatuses.join(', ')}`;
    }

    const issue = await ctx.issue.getIssue(id);
    if (!issue) {
      ctx.core.brief('error', 'issue_close', `Issue #${id} not found`);
      return `Error: Issue #${id} not found`;
    }

    await ctx.issue.closeIssue(id, status, comment, poster);
    ctx.core.brief('info', 'issue_close', `Closed issue #${id} as ${status}`);

    let result = `Closed issue #${id} "${issue.title}" as ${status}`;
    if (comment) {
      result += ` with comment: "${comment}"`;
    }
    return result;
  },
};