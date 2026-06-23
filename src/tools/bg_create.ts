/**
 * bg_create.ts - Run a bash command in the background
 *
 * Scope: ['main', 'child'] - Not 'bg' to avoid recursive background tasks
 *
 * Goes through the same bash grant system as the regular bash tool:
 * requires an `intent` and is rejected in plan mode or by user denial.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const bgCreateTool: ToolDefinition = {
  name: 'bg_create',
  description: 'Run a bash command asynchronously (non-blocking). Returns pid for use with bg_await/bg_print/bg_remove. Use for long-running commands like servers or builds. Subject to the same grant model as the bash tool (requires intent; rejected in plan mode).',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Bash command to run asynchronously. Runs in workspace directory. Cannot be interactive.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed. You MUST use the intent language to show your idea.',
      },
    },
    required: ['command', 'intent'],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const intent = args.intent as string;

    // Validate required parameters
    if (!command || typeof command !== 'string') {
      ctx.core.brief('error', 'bg_create', 'Missing or invalid command parameter');
      return 'Error: command parameter is required and must be a string';
    }
    if (!intent || typeof intent !== 'string') {
      ctx.core.brief('error', 'bg_create', 'Missing or invalid intent parameter');
      return 'Error: intent parameter is required and must be a string';
    }

    // Check permission (respects plan mode and intent validation) — same as bash tool
    const grant = await ctx.core.requestGrant('bash', { command, intent });
    if (!grant.approved) {
      const reason = grant.reason || 'Operation not permitted in current mode';
      ctx.core.brief('error', 'bg_create', `Command is rejected with reason: ${reason}\n\n${command}`, intent);
      return reason;
    }

    // Block direct git commit - must use git_commit tool
    if (/\bgit\s+commit\b/.test(command)) {
      const msg = 'Direct git commit is not allowed. Use the git_commit tool instead.';
      ctx.core.brief('error', 'bg_create', `Git commit is not allowed.\n\n${command}`, intent);
      return `Error: ${msg}`;
    }

    if (!ctx.bg) {
      ctx.core.brief('error', 'bg_create', 'Bg module not available');
      return 'Error: Bg module not available in this context';
    }

    ctx.core.brief('info', 'bg_create', `Running background command: ${command}`, intent);

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