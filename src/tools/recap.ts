/**
 * recap.ts - Compress checkpoint messages into a summary
 *
 * Scope: ['main'] - Only available to main agent (not teammates)
 *
 * NOTE: This is a META-TOOL. The tool definition is for LLM visibility,
 * but the actual execution happens in the state machine (hook.ts)
 * because it needs access to triologue which is not in AgentContext.
 *
 * Finds the checkpoint by ID and summarizes all messages from that point
 * into a concise summary, replacing the messages with the summary.
 */

import type { ToolDefinition } from '../types.js';

export const recapTool: ToolDefinition = {
  name: 'recap',
  description: `Compress messages from a checkpoint into a summary. Call after completing a subtask to clean up context.

Usage:
1. First create a checkpoint with checkpoint({ description: "..." })
2. Perform your subtask (read files, explore, investigate)
3. Call recap({ checkpoint_id: "..." }) with the ID from step 1
4. Messages from checkpoint onwards are replaced with a summary

Rules:
- Requires a valid checkpoint ID
- Summarizes all messages from checkpoint to end
- Marks the corresponding todo as done
- Only one checkpoint can be open at a time`,
  input_schema: {
    type: 'object',
    properties: {
      checkpoint_id: {
        type: 'string',
        description: 'The checkpoint ID returned by the checkpoint tool (8-character hash).',
      },
    },
    required: ['checkpoint_id'],
  },
  scope: ['main'],
  handler: () => {
    // This is a meta-tool - execution happens in hook.ts
    // The handler returns empty string because the real logic
    // is executed by the state machine using env.triologue
    return '';
  },
};