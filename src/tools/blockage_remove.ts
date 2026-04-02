/**
 * blockage_remove.ts - Remove a blocking relationship between issues
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const blockageRemoveTool: ToolDefinition = {
  name: 'blockage_remove',
  description: 'Remove a blocking relationship between two issues. The blocked issue will no longer be blocked by the blocker.',
  input_schema: {
    type: 'object',
    properties: {
      blocker: {
        type: 'integer',
        description: 'ID of the issue that was blocking',
      },
      blocked: {
        type: 'integer',
        description: 'ID of the issue that was blocked',
      },
    },
    required: ['blocker', 'blocked'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const blocker = args.blocker as number;
    const blocked = args.blocked as number;

    if (typeof blocker !== 'number' || !Number.isInteger(blocker)) {
      ctx.core.brief('error', 'blockage_remove', 'Invalid blocker parameter');
      return 'Error: blocker must be an integer';
    }
    if (typeof blocked !== 'number' || !Number.isInteger(blocked)) {
      ctx.core.brief('error', 'blockage_remove', 'Invalid blocked parameter');
      return 'Error: blocked must be an integer';
    }

    const blockerIssue = await ctx.issue.getIssue(blocker);
    const blockedIssue = await ctx.issue.getIssue(blocked);
    if (!blockerIssue) {
      ctx.core.brief('error', 'blockage_remove', `Blocker issue #${blocker} not found`);
      return `Error: Blocker issue #${blocker} not found`;
    }
    if (!blockedIssue) {
      ctx.core.brief('error', 'blockage_remove', `Blocked issue #${blocked} not found`);
      return `Error: Blocked issue #${blocked} not found`;
    }

    await ctx.issue.removeBlockage(blocker, blocked);
    ctx.core.brief('info', 'blockage_remove', `Removed blockage: #${blocker} no longer blocks #${blocked}`);

    return 'OK';
  },
};