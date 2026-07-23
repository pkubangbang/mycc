/**
 * checkpoint.ts - Create a checkpoint for context management
 *
 * Scope: ['main'] - Available to lead agent only
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
  description: `Create a checkpoint marker for context management. Use before exploration or investigation tasks that generate many messages. Must be called alone (no other tools in same turn).`,
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
  scope: ['main'],
  handler: () => {
    // This is a meta-tool - execution happens in hook.ts
    // The handler returns empty string because the real logic
    // is executed by the state machine using env.triologue
    return '';
  },
};