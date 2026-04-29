/**
 * issue_claim.ts - Claim an issue for work
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueClaimTool: ToolDefinition = {
  name: 'issue_claim',
  description: 'Claim a pending issue to start work. Sets status to in_progress and assigns owner. Returns full issue list.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'Issue ID number to claim. Use issue_list to find available pending issues.',
      },
      owner: {
        type: 'string',
        description: 'Name or identifier of who is claiming the issue. Should match the agent or person doing the work.',
      },
    },
    required: ['id', 'owner'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const id = args.id as number;
    const owner = args.owner as string;

    if (typeof id !== 'number' || !Number.isInteger(id)) {
      ctx.core.brief('error', 'issue_claim', 'Invalid id parameter');
      return 'Error: id must be an integer';
    }
    if (!owner || typeof owner !== 'string') {
      ctx.core.brief('error', 'issue_claim', 'Missing or invalid owner parameter');
      return 'Error: owner parameter is required and must be a string';
    }

    const issue = await ctx.issue.getIssue(id);
    if (!issue) {
      ctx.core.brief('error', 'issue_claim', `Issue #${id} not found`);
      return `Error: Issue #${id} not found`;
    }

    const claimed = await ctx.issue.claimIssue(id, owner);
    if (!claimed) {
      ctx.core.brief('warn', 'issue_claim', `Failed to claim issue #${id}`);
      return `Error: Failed to claim issue #${id}. It may not be in pending status or is already claimed.`;
    }

    ctx.core.brief('info', 'issue_claim', `Claimed issue #${id}: "${issue.title}" by @${owner}`);
    
    // Return full issue list for visibility
    return await ctx.issue.printIssues();
  },
};