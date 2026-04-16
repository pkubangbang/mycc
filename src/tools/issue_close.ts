/**
 * issue_close.ts - Close an issue with a final status
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueCloseTool: ToolDefinition = {
  name: 'issue_close',
  description: 'Close an issue with final status: completed, failed, or abandoned. Use after issue_claim when work is done. Closing a blocker unblocks dependent issues.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Issue ID number to close.',
      },
      status: {
        type: 'string',
        enum: ['completed', 'failed', 'abandoned'],
        description: 'completed: Successfully resolved. failed: Could not complete due to errors. abandoned: No longer needed.',
      },
      comment: {
        type: 'string',
        description: 'Final comment explaining the resolution or reason for closure.',
      },
      poster: {
        type: 'string',
        description: 'Name of the person or agent closing the issue. Defaults to anonymous if omitted.',
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
    const logMsg = comment
      ? `Closed #${id} as ${status}: "${comment}"`
      : `Closed #${id} as ${status}`;
    ctx.core.brief('info', 'issue_close', logMsg);

    return `OK: #${id}`;
  },
};