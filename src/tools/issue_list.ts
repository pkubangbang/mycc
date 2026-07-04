/**
 * issue_list.ts - List all issues
 *
 * Scope: ['main', 'child'] - Available to main and child agents
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const issueListTool: ToolDefinition = {
  name: 'issue_list',
  description: 'List all shared team issues with status, owner, and blocking relationships. Unlike private todos, issues are visible to all agents. Use to find pending issues to claim or check dependency status.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext): Promise<string> => {
    return await ctx.issue.printIssues();
  },
};