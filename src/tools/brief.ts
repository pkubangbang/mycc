/**
 * brief.ts - Send status update to user (child process only)
 *
 * This tool allows child process teammates to send status updates
 * that are visible to the user through the parent process.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const briefTool: ToolDefinition = {
  name: 'brief',
  description:
    'Send a status update message to the user. Use this to report progress, share information, or provide updates during task execution. The message will be displayed in the terminal.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The status message to display to the user',
      },
    },
    required: ['message'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const message = args.message as string;

    if (!message || typeof message !== 'string') {
      return 'Error: message parameter is required and must be a string';
    }

    // Use core.brief to send the message via IPC to parent
    ctx.core.brief('info', 'brief', message);
    return 'OK';
  },
};