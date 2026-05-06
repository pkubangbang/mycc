/**
 * brief.ts - Send status update to user
 *
 * This tool allows agents to send status updates that are visible
 * to the user through the parent process. The confidence parameter
 * helps regulate confusion tracking.
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const briefTool: ToolDefinition = {
  name: 'brief',
  description: 'Send a status update to the user. Displays message in terminal. Use to report progress or findings during task execution. IMPORTANT: Always include confidence parameter (0-10) to indicate your certainty about the current state.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The status message to display to the user',
      },
      confidence: {
        type: 'number',
        description: 'Your confidence level (0-10). High confidence (8-10) means you are certain and making progress. Low confidence (0-7) indicates uncertainty or being stuck. Use 10 for completed tasks, 8-9 for confident progress, 5-7 for moderate certainty, 0-4 when uncertain or blocked.',
        minimum: 0,
        maximum: 10,
      },
    },
    required: ['message', 'confidence'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const message = args.message as string;
    const confidence = args.confidence as number;

    if (!message || typeof message !== 'string') {
      return 'Error: message parameter is required and must be a string';
    }

    if (typeof confidence !== 'number' || confidence < 0 || confidence > 10) {
      return 'Error: confidence parameter is required and must be a number between 0 and 10';
    }

    // Update confusion index based on confidence
    // Formula: deltaConfusion = 8 - confidence
    // High confidence (8-10) reduces confusion, low confidence (0-7) increases it
    const deltaConfusion = 8 - confidence;
    ctx.core.increaseConfusionIndex(deltaConfusion);

    // Use core.brief to send the message via IPC to parent
    ctx.core.brief('info', 'brief', message);
    return 'OK';
  },
};