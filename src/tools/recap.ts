/**
 * recap.ts - Compress checkpoint messages into a summary
 *
 * Scope: ['main'] - Available to lead agent only
 *
 * NOTE: This is a META-TOOL. The tool definition is for LLM visibility,
 * but the actual execution happens in the state machine (hook.ts for lead,
 * teammate-worker.ts for child) because it needs access to triologue
 * which is not in AgentContext.
 *
 * Finds the checkpoint by ID and summarizes all messages from that point
 * into a concise summary, replacing the messages with the summary.
 * Does NOT add tool call/result messages to history (unlike regular tools).
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

IMPORTANT: This tool MUST be called alone. No other tools can be used in the same turn.

The tool replaces all messages from checkpoint onwards with a summary pair,
keeping your context clean and focused.

Output format (when not abandoning):
The recap generates a structured summary with these sections:
- Exploration Coverage: Files examined, what was found in each, what was ruled out
- Key Discoveries: Concrete findings with specificity (names, locations, line numbers)
- Current State: What the agent now knows that enables resumption without re-exploration or re-verification
- Next Steps: Recommended continuation actions, noting if the user's latest query steers in a different direction`,
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
      comment: {
        type: 'string',
        description: 'Optional comment from the LLM about the findings, decisions, or key takeaways from this checkpoint. Included in the recap log for user visibility.',
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