/**
 * checkpoint.ts - Create a checkpoint for context management
 *
 * Scope: ['main'] - Only available to main agent (not teammates)
 *
 * NOTE: This is a META-TOOL. The tool definition is for LLM visibility,
 * but the actual execution happens in the state machine (hook.ts)
 * because it needs access to triologue which is not in AgentContext.
 *
 * Creates a checkpoint marker in the conversation history.
 * Use before starting a focused subtask (exploration, investigation).
 * Later, use recap to compress messages from checkpoint to end into a summary.
 */

import type { ToolDefinition } from '../types.js';

export const checkpointTool: ToolDefinition = {
  name: 'checkpoint',
  description: `Create a marker in the chat history for quick summary.
  Use before exploration, investigation, or any task that will generate many messages.

  IMPORTANT: this tool MUST be used alone. Do not use other tools in the same chat round.
  `,
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