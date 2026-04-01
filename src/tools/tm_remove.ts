/**
 * tm_remove.ts - Remove a teammate (terminate child process)
 *
 * Scope: ['main'] - Only lead agent can remove teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmRemoveTool: ToolDefinition = {
  name: 'tm_remove',
  description: 'Remove a teammate by terminating their child process. Use this when a teammate is no longer needed.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the teammate to remove',
      },
    },
    required: ['name'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;

    // Validate required parameters
    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'tm_remove', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }

    // Check if teammate exists
    if (!ctx.team) {
      ctx.core.brief('error', 'tm_remove', 'Team module not available');
      return 'Error: Team module not available in this context';
    }

    const teammate = ctx.team.getTeammate(name);
    if (!teammate) {
      ctx.core.brief('warn', 'tm_remove', `Teammate '${name}' not found`);
      return `Error: Teammate '${name}' not found`;
    }

    ctx.core.brief('info', 'tm_remove', `Removing teammate '${name}' (role: ${teammate.role})`);

    try {
      ctx.team.removeTeammate(name);
      return `Teammate '${name}' removed successfully`;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_remove', err.message);
      return `Error: ${err.message}`;
    }
  },
};