/**
 * tm_create.ts - Create a teammate (child process agent)
 *
 * Scope: ['main'] - Only lead agent can create teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmCreateTool: ToolDefinition = {
  name: 'tm_create',
  description: 'Create a teammate with name, role and initial prompt. ' +
   // to prevent fraction in team-mode transition.
   'If you use this tool, you CANNOT use other tool in this round.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Unique identifier for the teammate (used for referencing in other commands)',
      },
      role: {
        type: 'string',
        description: 'Role description for the teammate (e.g., "coder", "reviewer", "tester")',
      },
      prompt: {
        type: 'string',
        description: 'Initial instructions and context for the teammate to follow',
      },
    },
    required: ['name', 'role', 'prompt'],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const role = args.role as string;
    const prompt = args.prompt as string;

    // Validate required parameters
    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'tm_create', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }
    if (!role || typeof role !== 'string') {
      ctx.core.brief('error', 'tm_create', 'Missing or invalid role parameter');
      return 'Error: role parameter is required and must be a string';
    }
    if (!prompt || typeof prompt !== 'string') {
      ctx.core.brief('error', 'tm_create', 'Missing or invalid prompt parameter');
      return 'Error: prompt parameter is required and must be a string';
    }

    ctx.core.brief('info', 'tm_create', `Creating teammate '${name}' with role: ${role}`);

    if (!ctx.team) {
      ctx.core.brief('error', 'tm_create', 'Team module not available');
      return 'Error: Team module not available in this context';
    }

    try {
      const result = await ctx.team.createTeammate(name, role, prompt);
      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_create', err.message);
      return `Error: ${err.message}`;
    }
  },
};