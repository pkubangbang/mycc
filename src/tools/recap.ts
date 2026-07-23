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
  description: `Close a checkpoint and compress its messages into a summary. Set abandon=true to discard without summarizing. Must be called alone (no other tools in same turn).

The 'comment' field is REQUIRED and is the most important part of the recap: it determines the direction of the next turn. Write it as a clear, actionable directive stating what should happen next based on what was discovered during this checkpoint. The comment is placed at the END of the recap note, so it is the last thing the conversation sees before continuing — treat it as the steering instruction for subsequent work.`,
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
        description: 'REQUIRED. A directive that determines the direction of the next turn. State what was concluded and what should happen next. This is placed last in the recap note and steers subsequent work, so be specific and actionable — not a vague log entry.',
      },
    },
    required: ['checkpoint_id', 'comment'],
  },
  scope: ['main'],
  handler: () => {
    // This is a meta-tool - execution happens in hook.ts
    // The handler returns empty string because the real logic
    // is executed by the state machine using env.triologue
    return '';
  },
};