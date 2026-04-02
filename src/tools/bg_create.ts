/**
 * bg_create.ts - Run a bash command in the background
 *
 * Scope: ['main', 'child'] - Not 'bg' to avoid recursive background tasks
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgCreateTool: ToolDefinition = {
  name: 'bg_create',
  description: 'Run a bash command in the background. Returns the process ID for tracking.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to run in background',
      },
    },
    required: ['command'],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;

    // Validate required parameter
    if (!command || typeof command !== 'string') {
      ctx.core.brief('error', 'bg_create', 'Missing or invalid command parameter');
      return 'Error: command parameter is required and must be a string';
    }

    ctx.core.brief('info', 'bg_create', `Running background command: ${command}`);

    if (!ctx.bg) {
      ctx.core.brief('error', 'bg_create', 'Bg module not available');
      return 'Error: Bg module not available in this context';
    }

    try {
      const pid = await ctx.bg.runCommand(command);
      return `OK: ${pid}`;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'bg_create', err.message);
      return `Error: ${err.message}`;
    }
  },
};