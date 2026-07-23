/**
 * issue_publish.ts - Publish a draft issue to make it claimable
 *
 * Transitions an issue from 'draft' to 'pending'. A published issue becomes
 * visible to idle teammates for auto-claim (enterIdleState only claims
 * 'pending' issues). Use this when the lead wants any available teammate to
 * pick up the issue rather than assigning it to a specific one.
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issuePublishTool: ToolDefinition = {
  name: 'issue_publish',
  description: 'Publish a draft issue, transitioning it from draft to pending so it becomes visible to idle teammates for auto-claim. Use this when you want any available teammate to pick up the issue rather than assigning it to a specific one. Returns full issue list.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Issue ID number to publish. The issue must be in draft status. Use issue_list to find draft issues.',
      },
    },
    required: ['id'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const id = args.id as number;

    if (typeof id !== 'number' || !Number.isInteger(id)) {
      ctx.core.brief('error', 'issue_publish', 'Invalid id parameter');
      return 'Error: id must be an integer';
    }

    const issue = await ctx.issue.getIssue(id);
    if (!issue) {
      ctx.core.brief('error', 'issue_publish', `Issue #${id} not found`);
      return `Error: Issue #${id} not found`;
    }

    const published = await ctx.issue.publishIssue(id);
    if (!published) {
      ctx.core.brief('warn', 'issue_publish', `Failed to publish issue #${id}`);
      return `Error: Failed to publish issue #${id}. It may not be in draft status (current: ${issue.status}).`;
    }

    ctx.core.brief('info', 'issue_publish', `Published issue #${id}: "${issue.title}"`);

    // Return full issue list for visibility
    return await ctx.issue.printIssues();
  },
};