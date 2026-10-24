/**
 * stop-prevent-stop.ts - Pinned-todo stop guard (STOP stage gate)
 *
 * A pinned todo may carry a natural-language `preventStop` condition — a
 * promise the agent made to itself ("keep going until every test passes").
 * At the end of EVERY turn, this module asks the LLM whether any of those
 * conditions still holds. If one does, STOP does not complete: it returns
 * COLLECT with a SYSTEM note naming the reason, so the agent keeps working
 * across turn boundaries (long-horizon tasks).
 *
 * Design notes
 * ------------
 * - ONE forkChat per STOP, no matter how many guards are present: all
 *   candidates are batched into a single JSON-array prompt. With zero
 *   candidates the function returns immediately without an LLM call, so an
 *   unguarded todo list costs nothing at turn end.
 * - No safety valve / hold counter. A bounded counter would fight the
 *   feature's purpose. The escapes are intrinsic: the condition stops
 *   holding, or the agent un-pins the todo / clears the guard (see
 *   `Todo.pinTodo` — un-pinning clears `preventStop`).
 * - FAIL OPEN. Every failure path (forkChat throws, output is not JSON, an
 *   entry is malformed, or the evaluator is unsure) yields `block: false`:
 *   a guard must never trap a turn on an infrastructure hiccup. The guard
 *   re-arms on the next STOP.
 * - The verdict is the EVALUATOR's judgment, not the system's. The note
 *   keeps the agent-defined condition verbatim (so the reader can
 *   sanity-check it) and attributes the grounds to the evaluator.
 * - `updateTodo` is never called: this is a gate, not a mutation.
 */

import type { MachineEnv } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { forkChat } from '../../engine/chat-provider.js';

/**
 * Shape of a single stop-guard evaluation returned by the LLM via forkChat.
 */
export interface PreventStopEvaluation {
  id: number;
  hash: string;
  hold: boolean;
  reason?: string;
}

/** What STOP does with the verdict of this check. */
export interface PreventStopVerdict {
  /** true → the turn must NOT end; STOP returns COLLECT with `note`. */
  block: boolean;
  /** SYSTEM note body explaining why the turn continues (topmost held guard). */
  note?: string;
}

/**
 * Parse the forkChat result into a list of evaluations.
 *
 * Tolerant parsing: tries a direct `JSON.parse` first; on failure, attempts to
 * regex-extract the first `[...]` JSON array and retry; on any failure or
 * non-array shape, returns null (caller lets the turn end).
 *
 * Exported for unit testing (see src/tests/loop/states/stop-prevent-stop.test.ts).
 */
export function parsePreventStopResult(raw: string): PreventStopEvaluation[] | null {
  const trimmed = raw.trim();
  // 1. Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as PreventStopEvaluation[];
    return null;
  } catch {
    // fall through to extraction
  }
  // 2. Extract first JSON array from surrounding noise
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed as PreventStopEvaluation[];
  } catch {
    // give up
  }
  return null;
}

/**
 * Evaluate pinned todos carrying a stop guard and decide whether the turn may
 * end. Called by STOP before it reports a result / branches to PROMPT.
 *
 * Failure modes are all silent (verbose-only) and all fail open:
 *  - no candidates → no forkChat call, `{block:false}`
 *  - forkChat throws / ESC → `{block:false}`
 *  - non-JSON / non-array result → `{block:false}`
 *  - per-entry: wrong types, hash mismatch (hallucination), hold=false → skip
 */
export async function checkPreventStop(env: MachineEnv): Promise<PreventStopVerdict> {
  const { triologue, ctx } = env;
  const candidates = ctx.todo.getPreventStopCandidates();
  if (candidates.length === 0) return { block: false };

  // Build the evaluation prompt. `id` is fixed (echoed back); `hash` is
  // supplied by the LLM from the conversation context so the anti-hallusion
  // check stays active — a fabricated hash won't match the candidate.
  // The done marker is included so the evaluator can tell a finished item
  // (guard is the only reason to keep going) from unfinished work.
  const todoLines = candidates.map(
    (c) => `#${c.id} ${c.done ? '[done]' : '[open]'} "${c.name}" — preventStop: "${c.preventStop}"` +
      `${c.note ? ` (note: ${c.note})` : ''}`,
  );
  const prompt =
    'You are deciding whether the agent is ALLOWED TO END ITS TURN.\n\n' +
    `Pinned todos carrying a stop guard:\n${todoLines.join('\n')}\n\n` +
    'Based on the conversation context above, for EACH todo decide whether its ' +
    'preventStop condition still holds — i.e. whether the work it protects is ' +
    'still unfinished.\n\n' +
    'Reply with ONLY a JSON array, no other text. Schema:\n' +
    '[\n' +
    '  {"id": <todo_id>, "hash": "<current_hash_of_this_todo>", "hold": <true|false>, "reason": "<one sentence>"}\n' +
    ']\n\n' +
    'Rules:\n' +
    '- "id": the todo ID as listed above (echo it back).\n' +
    '- "hash": the current hash of this todo item (from the todo list you have seen in conversation).\n' +
    '- "hold": true only if the condition clearly still holds and there is real work left.\n' +
    '- If the condition is satisfied, or you are unsure, use false.\n' +
    '- Do not hold the turn based on work that predates the todo\'s last completion.';

  const fullMessages = triologue.getMessages();
  const allTools = loader.getToolsForScope(env.scope);

  let result: string;
  try {
    // Wrap in escAware so ESC (WebUI "停止" button / terminal ESC) aborts the
    // forkChat immediately. A slow endpoint must not keep the state machine
    // stuck in STOP for the full call duration. On ESC, '' is returned so
    // parsePreventStopResult() yields null → fail open → the turn ends.
    result = await ctx.core.escAware(
      async (abortController) => {
        return await forkChat(fullMessages, allTools, prompt, abortController.signal, 'none');
      },
      () => '' as const,
    );
  } catch (err) {
    ctx.core.verbose('prevent-stop', `forkChat failed: ${(err as Error).message}, allowing the turn to end`);
    return { block: false };
  }

  const evaluations = parsePreventStopResult(result);
  if (!evaluations) {
    ctx.core.verbose('prevent-stop', 'forkChat returned non-JSON or non-array, allowing the turn to end');
    return { block: false };
  }

  for (const ev of evaluations) {
    // Per-entry type guards — skip malformed entries, keep going
    if (typeof ev.id !== 'number' || typeof ev.hash !== 'string' || typeof ev.hold !== 'boolean') {
      continue;
    }
    if (!ev.hold) continue;

    // Hash anti-hallusion: match by id AND hash. A hallucinated hash won't
    // match and the entry is silently skipped.
    const candidate = candidates.find((c) => c.id === ev.id && c.hash === ev.hash);
    if (!candidate) continue;

    // Topmost held guard wins — its reason is the one reported. Later held
    // entries are not evaluated for the verdict (a single reason is enough
    // to gate the turn; the agent re-runs the check after acting).
    ctx.core.verbose('prevent-stop', `guard #${candidate.id} held: ${ev.reason ?? '(no reason given)'}`);
    return {
      block: true,
      note:
        `Stop prevented — pinned guard #${candidate.id} "${candidate.name}" requires work to continue.\n` +
        `preventStop: "${candidate.preventStop}".` +
        `${ev.reason ? `\nEvaluator's stated grounds: ${ev.reason}` : ''}\n` +
        `Keep working towards it; when the condition no longer holds the turn can end. ` +
        `To release the guard early, unpin #${candidate.id} (todo_pinning with pinned=false).`,
    };
  }

  return { block: false };
}
