/**
 * question.ts - Ask user for input during tool execution
 *
 * This tool enables the "btw" (by the way) information supplying mechanism,
 * allowing the agent to pause and ask the user for clarification or
 * additional information during task execution.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const questionTool: ToolDefinition = {
  name: 'question',
  description:
    'Ask the user a question and wait for their response. Use this to get clarification or additional information during task execution.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The question to ask the user',
      },
    },
    required: ['query'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const query = args.query as string;
    try {
      const response = await ctx.core.question(query);
      return `User response: ${response}`;
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  },
};