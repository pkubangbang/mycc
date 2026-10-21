/**
 * brief.ts - Send status update to user
 *
 * This tool allows agents to send status updates that are visible
 * to the user through the parent process. The confidence parameter
 * helps regulate confusion tracking.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { PRISTINE_BRIEF_RESULT } from '../loop/triologue/recap-note.js';

/**
 * `brief` is shared by the lead AND teammates (`scope: ['main', 'child']`), so
 * its description is visible to agents that can never call `recap`. It must
 * therefore say nothing about recap or rewind anchors — that contract lives in
 * the recap tool's own description (lead-only) and in the lead's system prompt
 * (buildLeadAgentMemorySection). Do not re-add it here.
 *
 * `Must be called alone` STAYS: validateBriefIsolation rejects the whole turn
 * for every caller, so a teammate batching brief with another tool must know
 * the rule even though it is the lead who rewinds to these anchors.
 */
export const briefTool: ToolDefinition = {
  name: 'brief',
  description: 'Talk to yourself and let the user know. Use to report progress or findings during task execution. Always include a confidence score (0-10) indicating your certainty about the current state. State the conclusion first, then the evidence. Must be called alone (no other tools in the same turn).',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The status message to display to the user',
      },
      confidence: {
        type: 'number',
        description: 'Your confidence level (0-10): 10 = completed; 8-9 = confident progress; 5-7 = moderate certainty; 0-4 = uncertain or blocked.',
        minimum: 0,
        maximum: 10,
      },
    },
    required: ['message', 'confidence'],
  },
  scope: ['main', 'child'],
  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const message = args.message as string;
    const confidence = args.confidence as number;

    if (!message || typeof message !== 'string') {
      return 'Error: message parameter is required and must be a string';
    }

    if (typeof confidence !== 'number' || confidence < 0 || confidence > 10) {
      return 'Error: confidence parameter is required and must be a number between 0 and 10. ' +
        'Provide all required args in one call, e.g. brief(message="<status>", confidence=7).';
    }

    // Update confusion index based on confidence
    // Formula: deltaConfusion = 8 - confidence
    // High confidence (8-10) reduces confusion, low confidence (0-7) increases it
    const deltaConfusion = 8 - confidence;
    ctx.core.increaseConfusionIndex(deltaConfusion);

    // Record this brief into the peer heartbeat file so the `peers` tool can
    // surface the instance's recent progress. No-op for child processes
    // (NoopPeerModule.recordBrief). Content is truncated to 200 estimated tokens
    // inside the writer. Best-effort — must never break the brief tool path.
    try {
      ctx.peer.recordBrief(message, confidence);
    } catch {
      // Swallow — heartbeat recording is best-effort.
    }

    // Use core.brief to send the message via IPC to parent
    ctx.core.brief('info', 'brief', message, `confidence: ${confidence * 10}%`);
    // The PRISTINE result (triologue/recap-note.ts): recap rewrites exactly
    // this content in place with the span summary, so it must stay the single
    // literal — a different string here would make the brief look consumed and
    // quietly drop it as a rewind anchor.
    return PRISTINE_BRIEF_RESULT;
  },
};