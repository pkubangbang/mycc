/**
 * tm_create.ts - Create a teammate (child process agent)
 *
 * Scope: ['main'] - Only lead agent can create teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmCreateTool: ToolDefinition = {
  name: 'tm_create',
  description: 'Create a teammate with name, role and initial prompt. ' +
   'You can create multiple teammates in sequence before starting team coordination.',
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

    try {
      const result = await ctx.team.createTeammate(name, role, prompt);

      // Check if this is the first teammate created
      const teammates = ctx.team.listTeammates();
      if (teammates.length === 1) {
        // First teammate - provide kickoff instructions
        return result + '\n\n' +
          'KICKOFF REQUIRED: You just created your first teammate. Your next steps:\n' +
          '1. Create more teammates if needed (you can continue using tm_create)\n' +
          '2. Write a kickoff todo list using todo_write to coordinate team work\n' +
          '3. Distribute tasks to teammates using mail_to';
      }

      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_create', err.message);
      return `Error: ${err.message}`;
    }
  },
};