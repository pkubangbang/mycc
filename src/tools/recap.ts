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
  description: `Collapse the conversation back to a \`brief\`, replacing everything after it with a short note. Use it when exploration has produced many messages that are no longer worth carrying, or when a dead loop needs a fresh context with a new direction. A real \`brief\` result OPENS with a fixed anchor line — "[<hash>] ANCHOR — recap(target=\"<hash>\") folds the work after this point", optionally followed by a list of the other open anchors — so an anchor stays addressable — as a target again once new work lands below it, since recap folds what FOLLOWS an anchor.

WHERE IT LANDS. With no \`target\`: the newest brief you have already moved past (at least one message after its round-trip — another brief counts). After a rewind that brief's round-trip is last, so the next plain recap moves to the brief before; new activity (even one more brief) re-arms it, and a recap there overwrites its result with the new summary. With \`target="<hash>"\`: exactly that brief, even if the conversation has not moved past it yet — use it to hang this work's summary on an earlier point. An unknown hash — or one with nothing after it yet, which is every freshly printed anchor until new activity lands — is refused with the reason; nothing is collapsed.

The brief's tool result keeps its first line as LINE 1 — minus its \`recap(target=…)\` clause — and gains the summary as LINE 2 ("Note, a recap has reset the conversation here with summary: ..."), so both the anchor's identity and the summary survive — keep briefs meaningful, they are what survives. It cannot rewind past a context compaction. If the summary comes back empty the call is refused and nothing is collapsed (retry). Must be called alone (no other tools in the same turn).

Set abandon=true to collapse the span WITHOUT summarizing it (the work is discarded). comment is REQUIRED unless abandon, and determines the direction of the next turn: write a clear, actionable directive stating what should happen next. It is placed at the END of the note — the last thing the conversation sees — so treat it as the steering instruction for subsequent work.`,
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'OPTIONAL. The hash shown at the start of the brief result you want to collapse back to (an anchor line reads `[<hash>] ANCHOR — recap(target="<hash>") …`; pass just `<hash>`). Omit to collapse to your newest usable brief.',
      },
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
