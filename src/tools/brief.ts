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
  description: 'Talk to yourself and let the user know. Use to report progress or findings during task execution. Always include a confidence score (0-10) indicating your certainty about the current state.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The status message to display to the user',
      },
      confidence: {
        type: 'number',
        description: 'Your confidence level (0-10): 10 = completed; 8-9 = confident progress; 5-7 = moderate certainty; 0-4 = uncertain or blocked.',
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

    // Record this brief into the peer heartbeat file so the `peers` tool can
    // surface the instance's recent progress. No-op for child processes
    // (NoopPeerModule.recordBrief). Content is truncated to 200 estimated tokens
    // inside the writer. Best-effort — must never break the brief tool path.
    try {
      ctx.peer.recordBrief(message, confidence);
    } catch {
      // Swallow — heartbeat recording is best-effort.
    }

    // Use core.brief to send the message via IPC to parent
    ctx.core.brief('info', 'brief', message, `confidence: ${confidence * 10}%`);
    return 'OK';
  },
};