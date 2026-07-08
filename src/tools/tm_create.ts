/**
 * tm_create.ts - Create a teammate (child process agent)
 *
 * Scope: ['main'] - Only lead agent can create teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import path from 'path';

export const tmCreateTool: ToolDefinition = {
  name: 'tm_create',
  description: 'Spawn a new teammate agent with a specific role. Assign work via mail_to after creation. Only available to lead agent (scope: main).',
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
      cwd: {
        type: 'string',
        description: 'Working directory for the teammate (e.g., a worktree path). If omitted, uses the lead\'s current working directory. Use this to spawn a teammate directly inside a git worktree for parallel branch work.',
      },
    },
    required: ['name', 'role', 'prompt'],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const name = args.name as string;
    const role = args.role as string;
    const prompt = args.prompt as string;
    const cwd = args.cwd as string | undefined;

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

    ctx.core.brief('info', 'tm_create', `Creating teammate '${name}' with role: ${role}`, prompt);

    // Enforce the worktree directory-name convention: the worktree directory
    // basename must equal the teammate name. This lets us derive the
    // teammate→worktree mapping from `git worktree list` without a JSON store.
    if (cwd) {
      const dirName = path.basename(cwd);
      if (dirName !== name) {
        ctx.core.brief('error', 'tm_create', `Worktree dir '${dirName}' does not match teammate name '${name}'`);
        return `Error: The worktree directory name must match the teammate name. Expected '${name}', got '${dirName}'. Use cwd=".worktrees/${name}".`;
      }
    }

    try {
      const result = await ctx.team.createTeammate(name, role, prompt, cwd);

      // If a cwd (worktree) was assigned, create a cleanup-tracking todo so
      // the lead remembers to remove the worktree. The worktree itself is
      // tracked via `git worktree list` — no JSON persistence needed.
      if (cwd) {
        ctx.todo.createTodo(
          `Remove worktree for teammate '${name}'`,
          `cwd=${cwd}`
        );
      }

      // Check if this is the first teammate created
      const teammates = ctx.team.listTeammates();
      if (teammates.length === 1) {
        // First teammate - provide kickoff instructions
        return `${result  }\n\n` +
          `KICKOFF REQUIRED: You just created your first teammate. Your next steps:\n` +
          `1. Create more teammates if needed (you can continue using tm_create)\n` +
          `2. Write a kickoff todo list using todo_create to coordinate team work\n` +
          `3. Distribute tasks to teammates using mail_to`;
      }

      return result;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_create', err.message);
      return `Error: ${err.message}`;
    }
  },
};