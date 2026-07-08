/**
 * tm_remove.ts - Remove a teammate (terminate child process)
 *
 * Scope: ['main'] - Only lead agent can remove teammates
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const tmRemoveTool: ToolDefinition = {
  name: 'tm_remove',
  description: 'Terminate a teammate process. Use tm_await first to let them finish. Set force=true only for stuck teammates. Only available to lead agent.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the teammate to remove',
      },
      force: {
        type: 'boolean',
        description: 'If true, forcefully kill the process; otherwise send soft shutdown (default: false)',
      },
    },
    required: ['name'],
  },
  scope: ['main'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const name = args.name as string;
    const force = (args.force as boolean) || false;

    // Validate required parameters
    if (!name || typeof name !== 'string') {
      ctx.core.brief('error', 'tm_remove', 'Missing or invalid name parameter');
      return 'Error: name parameter is required and must be a string';
    }

    const teammate = ctx.team.getTeammate(name);
    if (!teammate) {
      ctx.core.brief('warn', 'tm_remove', `Teammate '${name}' not found`);
      return `Error: Teammate '${name}' not found`;
    }

    const mode = force ? 'forcefully' : 'gracefully';
    ctx.core.brief('info', 'tm_remove', `Removing teammate '${name}' ${mode} (role: ${teammate.role})`);

    try {
      ctx.team.removeTeammate(name, force);

      // Close the cleanup todo auto-created in tm_create for this teammate.
      // The todo note follows the convention `cwd=<path>`. The actual git
      // worktree directory is left for the lead to remove via bash
      // (e.g., `git worktree remove .worktrees/<name>`).
      const todos = ctx.todo.getItems().filter(
        (i) => !i.done && i.note && i.note.startsWith('cwd=')
      );
      for (const todo of todos) {
        // Only close todos whose cwd path basename matches the teammate name
        const cwdVal = todo.note!.substring(4);
        const lastSeg = cwdVal.replace(/\\/g, '/').split('/').pop();
        if (lastSeg === name) {
          ctx.todo.updateTodo(todo.id, todo.hash, todo.name, true, todo.note);
          ctx.core.brief('info', 'tm_remove', `Closed worktree cleanup todo for '${name}' (${cwdVal})`);
        }
      }

      return 'OK';
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tm_remove', err.message);
      return `Error: ${err.message}`;
    }
  },
};