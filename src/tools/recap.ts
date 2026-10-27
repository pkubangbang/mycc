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
 * targeted brief and writes one note into that brief's own tool RESULT —
 * replacing everything after it:
 *
 *   tool('brief', "[<hash>] ANCHOR\n[RECAP]\n<your summary, verbatim>")
 *
 * The tool takes exactly TWO arguments, both required: the anchor to fold to
 * and the summary that replaces the discarded span. The summary is copied
 * VERBATIM into the anchor's result — it is the model's own text, not a
 * generated digest.
 */

import type { ToolDefinition } from '../types.js';

export const recapTool: ToolDefinition = {
  name: 'recap',
  description: `Collapse the conversation back to a \`brief\`, replacing everything after it with your \`summary\`. Use it when a subtask is complete and its narrative is crowding out what comes next, or when a dead loop needs a fresh context.

Both arguments are REQUIRED. \`target_brief\` is the hash from the brief result you fold to — an anchor line reads \`[<hash>] ANCHOR — …\`, so pass just \`<hash>\`; there is no default. An unknown hash, or one with nothing after it yet, is refused and nothing is collapsed.

\`summary\` is written VERBATIM into that brief's result after a \`[RECAP]\` line, and it is the ONLY record of the deleted work: state what was found, what now holds, and how the next turn should proceed — its last lines are the last thing the conversation sees. Pass an EMPTY STRING to discard the span without a summary. Must be called alone (no other tools in the same turn).`,
  input_schema: {
    type: 'object',
    properties: {
      target_brief: {
        type: 'string',
        description: 'REQUIRED. The hash of the brief to fold to — the token in `[<hash>] ANCHOR — recap(target="<hash>") …`. Never omitted.',
      },
      summary: {
        type: 'string',
        description: 'REQUIRED. The text written verbatim into the target brief\'s result after `[RECAP]`. It is the only record of the discarded span: cover findings, current state and next direction. Pass "" to discard the span without a summary.',
      },
    },
    required: ['target_brief', 'summary'],
  },
  scope: ['main'],
  handler: () => {
    throw new Error(
      'recap is a meta-tool: HOOK handles it before the TOOL stage, so this handler must never run.',
    );
  },
};
