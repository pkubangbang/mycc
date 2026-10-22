/**
 * recap.ts - Collapse the conversation back to the last brief
 *
 * Scope: ['main'] - Available to lead agent only
 *
 * NOTE: This is a META-TOOL. The tool definition is for LLM visibility,
 * but the actual execution happens in the state machine (hook.ts) because
 * it needs access to triologue, which is not in AgentContext.
 *
 * Every `brief` is a rewind anchor. recap truncates the conversation at the
 * LAST (not-yet-consumed) brief and writes one note into that brief's own tool
 * RESULT — replacing everything after it:
 *
 *   tool('brief', "OK Note, a recap has reset the conversation here with summary: \"…\"")
 *
 * so the brief's text and the summary of the deleted span both survive as a
 * tool result. Calling recap again rewinds further back, to the brief before,
 * and overwrites THAT brief's result with the new summary.
 */

import type { ToolDefinition } from '../types.js';

export const recapTool: ToolDefinition = {
  name: 'recap',
  description: `Collapse the conversation back to your last \`brief\`, replacing everything after it with a short note. Use it when exploration has produced many messages that are no longer worth carrying. A brief becomes the rewind anchor once the conversation has moved past it (at least one message after its round-trip — another brief counts): its tool result is rewritten to "OK Note, a recap has reset the conversation here with summary: ..." so its text and the summary both survive, so keep briefs meaningful — they are what survives. Calling recap repeatedly rewinds progressively further — after a rewind the anchor's round-trip is last, so the next call rewinds to the brief before; new activity (even one more brief) re-arms that anchor, and a recap there overwrites its result with the new summary. It cannot rewind past a context compaction. If the summary comes back empty the call is refused and nothing is collapsed (retry). Must be called alone (no other tools in the same turn).

Set abandon=true to collapse the span WITHOUT summarizing it (the work is discarded). comment is REQUIRED unless abandon, and determines the direction of the next turn: write a clear, actionable directive stating what should happen next. It is placed at the END of the note — the last thing the conversation sees — so treat it as the steering instruction for subsequent work.`,
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'REQUIRED. A short label for this collapse — what this stretch of work was about. Quoted in the note header.',
      },
      abandon: {
        type: 'boolean',
        description: 'If true, collapse without summarizing: the messages after the brief are discarded.',
      },
      comment: {
        type: 'string',
        description: 'REQUIRED unless abandon. A directive that determines the direction of the next turn: state what was concluded and what should happen next. Placed last in the recap note, so be specific and actionable — not a vague log entry.',
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
