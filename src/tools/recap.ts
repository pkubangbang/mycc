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
  description: `Close a checkpoint. Use after completing or abandoning a subtask.

Usage:
1. First create a checkpoint with checkpoint({ description: "..." })
2. Perform your subtask (read files, explore, investigate)
3. Call recap to close the checkpoint:
   - recap({ checkpoint_id: "..." }) - Summarize and close (subtask completed)
   - recap({ checkpoint_id: "...", abandon: true }) - Discard and close (subtask abandoned)

Rules:
- Requires a valid checkpoint ID
- Without abandon: Summarizes all messages from checkpoint to end
- With abandon: Discards all messages from checkpoint to end (no summary)
- Marks the corresponding todo as done
- Only one checkpoint can be open at a time`,
  input_schema: {
    type: 'object',
    properties: {
      checkpoint_id: {
        type: 'string',
        description: 'The checkpoint ID returned by the checkpoint tool (8-character hash).',
      },
      abandon: {
        type: 'boolean',
        description: 'If true, discard messages without summarizing. Use when abandoning a distracted subtask.',
      },
    },
    required: ['checkpoint_id'],
  },
  scope: ['main', 'child'],
  handler: () => {
    // This is a meta-tool - execution happens in hook.ts
    // The handler returns empty string because the real logic
    // is executed by the state machine using env.triologue
    return '';
  },
};