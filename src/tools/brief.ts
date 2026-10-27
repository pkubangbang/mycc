/**
 * brief.ts - Send status update to user
 *
 * This tool allows agents to send status updates that are visible
 * to the user through the parent process. The confidence parameter
 * helps regulate confusion tracking.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import {
  briefMessageVerdict,
  briefOverTargetWarning,
  briefTooLongError,
} from '../loop/triologue/brief.js';

/**
 * `brief` is shared by the lead AND teammates (`scope: ['main', 'child']`) and
 * its result is a plain `OK.` for both. There is no model-facing anchor, no
 * hash and no fold call to describe: the decision to fold a finished span is
 * made OUTSIDE the conversation (`recap-signal.ts`), so nothing the model can
 * type addresses a span. The lead's system prompt explains the fold; the tool
 * description stays a reporter's contract for every caller.
 *
 * `Must be called alone` STAYS: validateBriefIsolation rejects the whole turn
 * for every caller. Its reason changed with the fold — no longer "the model
 * needs an unambiguous target", but "the loop's span slicing needs an
 * unambiguous boundary": a brief batched with other calls yields a mid-turn
 * boundary that `resolveAnchor` -> `resultIndex + 1` -> `sliceFrom` was never
 * designed to cut at, and the fold runs on exactly that boundary.
 */
export const briefTool: ToolDefinition = {
  name: 'brief',
  description: 'Talk to yourself and let the user know. Use to report progress or findings during task execution. Always include a confidence score (0-10) indicating your certainty about the current state. State the conclusion first, then the evidence. Be concise: this is a status line, not a working note — the detail belongs in your next tool result. Must be called alone (no other tools in the same turn).',
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

    // THE MESSAGE CAP — two tiers, checked BEFORE anything is recorded:
    //
    //   over the hard limit  → HARD FAILURE. Nothing is recorded: no confusion
    //                          update, no heartbeat, no terminal line. A brief
    //                          that is rejected must not leave a half-written
    //                          trail behind.
    //   over the target      → SUCCESS, with a warning appended to the result
    //                          so the model can calibrate. The message itself
    //                          is kept verbatim — never silently clipped, since
    //                          a shortened status line misreports how much the
    //                          agent actually said.
    const verdict = briefMessageVerdict(message);
    if (verdict === 'fail') {
      return briefTooLongError();
    }
    const overTargetWarning = verdict === 'warn' ? briefOverTargetWarning() : '';

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
    // A plain success line, `OK.` — and that is the WHOLE result the model
    // reads. Nothing stamps it any more: with the fold decided outside the
    // conversation there is no address to print. The success text ends with a
    // period because a result may carry more after it ("OK. When thinking on
    // the larger scope, …") — that section is added by the HOOK stage in plan
    // mode, never here: the tool stays a reporter, the loop owns the
    // enhancement.
    //
    // An over-target (but accepted) message carries its warning HERE, so the
    // model learns the cost of what it just wrote. The full text is still shown
    // to the user verbatim, never clipped.
    return overTargetWarning ? `OK.${overTargetWarning}` : 'OK.';
  },
};