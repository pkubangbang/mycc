/**
 * issue_claim.ts - Claim an issue for work
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueClaimTool: ToolDefinition = {
  name: 'issue_claim',
  description: 'Claim an issue to start working on it. Sets status to in_progress and assigns an owner. Only works on pending issues.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        description: 'ID of the issue to claim',
      },
      owner: {
        type: 'string',
        description: 'Name or identifier of the owner claiming the issue',
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

    ctx.core.brief('info', 'issue_claim', `Claimed issue #${id} for ${owner}`);
    return `OK: #${id}`;
  },
};