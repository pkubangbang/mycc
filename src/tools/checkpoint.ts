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
  description: `Create a checkpoint marker before starting a focused subtask. Use before exploration, investigation, or any task that will generate many messages. Later, call recap with the checkpoint ID to compress those messages into a summary.

Rules:
- Only ONE open checkpoint allowed at a time
- Must be called ALONE (no other tools in same turn)
- Creates a todo item to track the checkpoint
- Use recap to close the checkpoint and compress messages

Example:
1. checkpoint({ description: "find authentication logic" })
2. [explore files, read code, investigate]
3. recap({ checkpoint_id: "abc12345" })
4. Continue with clean context and summary of findings`,
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