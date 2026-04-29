/**
 * issue_create.ts - Create a new issue
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueCreateTool: ToolDefinition = {
  name: 'issue_create',
  description: 'Create a new issue to track work. Returns full issue list for visibility. Use blockedBy to set dependencies.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Concise summary of the issue (1-10 words recommended). Used for quick reference in lists.',
      },
      content: {
        type: 'string',
        description: 'Detailed description of the issue including context, requirements, acceptance criteria, or steps to reproduce.',
      },
      blockedBy: {
        type: 'array',
        items: { type: 'integer' },
        description: 'List of issue IDs that must be completed before this issue can be worked on. Creates blocking relationships automatically.',
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

    // Return full issue list for visibility (like todo_write)
    return await ctx.issue.printIssues();
  },
};