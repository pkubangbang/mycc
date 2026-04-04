/**
 * issue_comment.ts - Add a comment to an issue
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueCommentTool: ToolDefinition = {
  name: 'issue_comment',
  description: 'Add a comment to an existing issue. The poster is automatically recorded.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'ID of the issue to comment on',
      },
      comment: {
        type: 'string',
        description: 'Comment text to add',
      },
      poster: {
        type: 'string',
        description: 'Name of the commenter (optional, defaults to anonymous)',
      },
    },
    required: ['id', 'comment'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const id = args.id as number;
    const comment = args.comment as string;
    const poster = args.poster as string | undefined;

    if (typeof id !== 'number' || !Number.isInteger(id)) {
      ctx.core.brief('error', 'issue_comment', 'Invalid id parameter');
      return 'Error: id must be an integer';
    }
    if (!comment || typeof comment !== 'string') {
      ctx.core.brief('error', 'issue_comment', 'Missing or invalid comment parameter');
      return 'Error: comment parameter is required and must be a string';
    }

    const issue = await ctx.issue.getIssue(id);
    if (!issue) {
      ctx.core.brief('error', 'issue_comment', `Issue #${id} not found`);
      return `Error: Issue #${id} not found`;
    }

    await ctx.issue.addComment(id, comment, poster);
    ctx.core.brief('info', 'issue_comment', `Added comment to #${id}: "${comment}"`);

    return 'OK';
  },
};