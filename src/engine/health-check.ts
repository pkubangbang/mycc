/**
 * health-check.ts — Shared health check types and probe helper.
 * Each provider exports its own healthCheck() function.
 */

import type { ChatResponse } from 'ollama';
import type { RetryChatRequest, RetryChatConfig } from './chat-helpers.js';

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  modelInfo?: {
    name: string;
    contextLength: number;
    family?: string;
    parameterSize?: string;
  };
}

export const STARTUP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'start_up',
    description:
      'Report model capabilities and provide a fun message of the day. Call this tool exactly once with your model information.',
    parameters: {
      type: 'object',
      properties: {
        context_length: {
          type: 'number',
          description: 'The maximum context window size in tokens for this model',
        },
        motd: {
          type: 'string',
          description: 'A fun, creative, or witty message of the day (a short phrase, wordplay, or greeting)',
        },
      },
      required: ['context_length', 'motd'],
    },
  },
};

export async function probeModel(
  retryChat: (req: RetryChatRequest, cfg?: RetryChatConfig) => Promise<ChatResponse>,
  MODEL: string,
): Promise<{ contextLength: number; motd: string }> {
  let contextLength = 4096;
  let motd = 'Ready!';

  const response = await retryChat(
    {
      model: MODEL,
      messages: [
        {
          role: 'user',
          content:
            `You are starting up. Call the start_up tool to report your context length ` +
            `and provide a fun message of the day.`,
        },
      ],
      tools: [STARTUP_TOOL],
    },
    { noSpinner: true },
  );

  if (response.message.tool_calls && response.message.tool_calls.length > 0) {
    const toolCall = response.message.tool_calls[0];
    if (toolCall.function.name === 'start_up') {
      const args = toolCall.function.arguments as { context_length?: number; motd?: string };
      if (typeof args.context_length === 'number') {
        contextLength = args.context_length;
      }
      if (typeof args.motd === 'string' && args.motd.trim()) {
        motd = args.motd.trim();
      }
    }
  }

  return { contextLength, motd };
}
