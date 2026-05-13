/**
 * checkpoint.ts - Create a checkpoint for context management
 *
 * Scope: ['main', 'child'] - Available to both lead and teammate agents
 *
 * NOTE: This is a META-TOOL. The tool definition is for LLM visibility,
 * but the actual execution happens in the state machine (hook.ts for lead,
 * teammate-worker.ts for child) because it needs access to triologue
 * which is not in AgentContext.
 *
 * Creates a checkpoint marker in the conversation history.
 * Use before starting a focused subtask (exploration, investigation).
 * Later, use recap to compress messages from checkpoint to end into a summary.
 */

import type { ToolDefinition } from '../types.js';

export const checkpointTool: ToolDefinition = {
  name: 'checkpoint',
  description: `Create a marker in the chat history for context management.
Use before exploration, investigation, or any task that will generate many messages.

IMPORTANT: This tool MUST be called alone. No other tools can be used in the same turn.

After completing the subtask, call recap({ checkpoint_id: "..." }) to compress
the messages into a summary and keep your context clean.`,
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What the subtask will accomplish. Be specific and concise.',
      },
    },
    required: ['description'],
  },
  scope: ['main', 'child'],
  handler: () => {
    // This is a meta-tool - execution happens in hook.ts
    // The handler returns empty string because the real logic
    // is executed by the state machine using env.triologue
    return '';
  },
};