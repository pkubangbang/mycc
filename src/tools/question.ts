/**
 * question.ts - Ask user for input during tool execution (child-only)
 *
 * This tool is only available in child processes. The lead agent should not
 * ask questions directly - it receives questions from teammates and presents
 * them to the user.
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
  scope: ['child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const query = args.query as string;
    const asker = ctx.core.getName();
    try {
      const response = await ctx.core.question(query, asker);
      return `User response: ${response}`;
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  },
};