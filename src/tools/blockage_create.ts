/**
 * blockage_create.ts - Create a blocking relationship between issues
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const blockageCreateTool: ToolDefinition = {
  name: 'blockage_create',
  description: 'Create a blocking relationship: the blocker issue blocks the blocked issue. The blocked issue cannot be worked on until the blocker is resolved.',
  input_schema: {
    type: 'object',
    properties: {
      blocker: {
        type: 'integer',
        description: 'ID of the issue that is blocking',
      },
      blocked: {
        type: 'integer',
        description: 'ID of the issue that is being blocked',
      },
    },
    required: ['blocker', 'blocked'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const blocker = args.blocker as number;
    const blocked = args.blocked as number;

    if (typeof blocker !== 'number' || !Number.isInteger(blocker)) {
      ctx.core.brief('error', 'blockage_create', 'Invalid blocker parameter');
      return 'Error: blocker must be an integer';
    }
    if (typeof blocked !== 'number' || !Number.isInteger(blocked)) {
      ctx.core.brief('error', 'blockage_create', 'Invalid blocked parameter');
      return 'Error: blocked must be an integer';
    }
    if (blocker === blocked) {
      ctx.core.brief('error', 'blockage_create', 'Self-blocking not allowed');
      return 'Error: An issue cannot block itself';
    }

    const blockerIssue = await ctx.issue.getIssue(blocker);
    const blockedIssue = await ctx.issue.getIssue(blocked);
    if (!blockerIssue) {
      ctx.core.brief('error', 'blockage_create', `Blocker issue #${blocker} not found`);
      return `Error: Blocker issue #${blocker} not found`;
    }
    if (!blockedIssue) {
      ctx.core.brief('error', 'blockage_create', `Blocked issue #${blocked} not found`);
      return `Error: Blocked issue #${blocked} not found`;
    }

    await ctx.issue.createBlockage(blocker, blocked);
    ctx.core.brief('info', 'blockage_create', `Created blockage: #${blocker} blocks #${blocked}`);

    return 'OK';
  },
};