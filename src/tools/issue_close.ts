/**
 * issue_close.ts - Close an issue with a final status
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueCloseTool: ToolDefinition = {
  name: 'issue_close',
  description: 'Close a shared team issue with final status: completed, failed, or abandoned. A non-empty comment is REQUIRED to explain the resolution or reason for closure. Unlike private todos, issues are visible to all agents. Returns full issue list. Closing a blocker unblocks dependent issues.',
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
        description: 'REQUIRED. A non-empty final comment explaining the resolution or reason for closure. Closing an issue without a comment is rejected.',
      },
      poster: {
        type: 'string',
        description: 'Name of the person or agent closing the issue. Defaults to anonymous if omitted.',
      },
    },
    required: ['id', 'status', 'comment'],
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

    // comment is required and must be a non-empty, non-whitespace string
    if (typeof comment !== 'string' || comment.trim() === '') {
      ctx.core.brief('error', 'issue_close', 'Missing or empty comment');
      return 'Error: comment is required to explain the resolution or reason for closure. Provide a non-empty comment.';
    }

    const issue = await ctx.issue.getIssue(id);
    if (!issue) {
      ctx.core.brief('error', 'issue_close', `Issue #${id} not found`);
      return `Error: Issue #${id} not found`;
    }

    await ctx.issue.closeIssue(id, status, comment, poster);
    const logMsg = `Closed #${id} as ${status}: "${comment}"`;
    ctx.core.brief('info', 'issue_close', logMsg);

    // Return full issue list for visibility
    return await ctx.issue.printIssues();
  },
};