/**
 * issue_create.ts - Create a new issue
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueCreateTool: ToolDefinition = {
  name: 'issue_create',
  description: 'Create a new issue with an optional list of blocking issues. Returns the issue ID.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short title for the issue',
      },
      content: {
        type: 'string',
        description: 'Detailed description of the issue',
      },
      blockedBy: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Optional array of issue IDs that block this issue',
      },
    },
    required: ['title', 'content'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const title = args.title as string;
    const content = args.content as string;
    const blockedBy = (args.blockedBy as number[] | undefined) || [];

    if (!title || typeof title !== 'string') {
      ctx.core.brief('error', 'issue_create', 'Missing or invalid title parameter');
      return 'Error: title parameter is required and must be a string';
    }
    if (!content || typeof content !== 'string') {
      ctx.core.brief('error', 'issue_create', 'Missing or invalid content parameter');
      return 'Error: content parameter is required and must be a string';
    }

    const id = await ctx.issue.createIssue(title, content, blockedBy);
    ctx.core.brief('info', 'issue_create', `Created issue #${id}: ${title}`);

    return `OK: #${id}`;
  },
};