/**
 * collect-pinned-todo.ts - Pinned-todo reactivation evaluation (COLLECT sub-step)
 *
 * Extracted from collect.ts so the reactivation pass (forkChat evaluation +
 * reopen) sits beside its siblings collect-hint.ts / collect-skill.ts instead
 * of inline in the state handler. Behaviour is unchanged.
 */

import type { MachineEnv } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { forkChat } from '../../engine/chat-provider.js';

/**
 * Shape of a single reactivation evaluation returned by the LLM via forkChat.
 */
interface ReactivationEvaluation {
  id: number;
  hash: string;
  reopen: boolean;
  reason?: string;
}

/**
 * Parse the forkChat result into a list of reactivation evaluations.
 *
 * Tolerant parsing: tries a direct `JSON.parse` first; on failure, attempts to
 * regex-extract the first `[...]` JSON array and retry; on any failure or
 * non-array shape, returns null (caller skips this turn).
 *
 * Exported for unit testing (see src/tests/loop/states/collect-reactivation.test.ts).
 */
export function parseReactivationResult(raw: string): ReactivationEvaluation[] | null {
  const trimmed = raw.trim();
  // 1. Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as ReactivationEvaluation[];
    return null;
  } catch {
    // fall through to extraction
  }
  // 2. Extract first JSON array from surrounding noise
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed as ReactivationEvaluation[];
  } catch {
    // give up
  }
  return null;
}

/**
 * Evaluate completed pinned todos carrying a reactivation condition and reopen
 * those whose condition is met. Runs in the COLLECT state, immediately before
 * the todo nudge, on the same throttle cycle (so the nudge prints the
 * already-updated list — no "closed then reopened" contradiction).
 *
 * Uses `forkChat` with `toolChoice: 'none'` to preserve the prompt cache and
 * ask the LLM to return a JSON array. Every failure path is silent
 * (verbose-only) and never blocks the agent loop:
 *  - no candidates → no forkChat call
 *  - forkChat throws → catch, skip this turn
 *  - non-JSON / non-array result → skip this turn
 *  - per-entry: wrong types, hash mismatch (hallucination), reopen=false → skip entry
 */
export async function checkReactivation(env: MachineEnv): Promise<void> {
  const { triologue, ctx } = env;
  const candidates = ctx.todo.getReactivationCandidates();
  if (candidates.length === 0) return;

  // Build the evaluation prompt. `id` is fixed (echoed back); `hash` is
  // supplied by the LLM from the conversation context so the anti-hallusion
  // check stays active — a fabricated hash won't match the candidate.
  const todoLines = candidates.map(
    (c) => `#${c.id} "${c.name}" — Condition: "${c.reactivate}"`,
  );
  const prompt =
    'You are evaluating whether any pinned todos should be reactivated (marked back to not done).\n\n' +
    `Pinned todos to evaluate:\n${todoLines.join('\n')}\n\n` +
    'Based on the conversation context above, for EACH todo, determine if its reactivation condition has been met.\n\n' +
    'Reply with ONLY a JSON array, no other text. Schema:\n' +
    '[\n' +
    '  {"id": <todo_id>, "hash": "<current_hash_of_this_todo>", "reopen": <true|false>, "reason": "<one sentence>"}\n' +
    ']\n\n' +
    'Rules:\n' +
    '- "id": the todo ID as listed above (echo it back).\n' +
    '- "hash": the current hash of this todo item (from the todo list you have seen in conversation).\n' +
    '- "reopen": true only if the condition has clearly been met in the recent conversation.\n' +
    '- If no relevant event has occurred, or you are unsure, use false.\n' +
    '- Do not reactivate based on events that happened before the todo was last completed.';

  const fullMessages = triologue.getMessages();
  const allTools = loader.getToolsForScope(env.scope);

  let result: string;
  try {
    // Wrap in escAware so ESC (WebUI "停止" button / terminal ESC) aborts the
    // forkChat immediately. Without this, a slow endpoint keeps the state
    // machine stuck in COLLECT for the full call duration, and every
    // subsequent click is a no-op (triggerNeglection() guards with
    // isNeglectedMode()). On ESC, return '' so parseReactivationResult()
    // yields null → function returns early → COLLECT routes to STOP.
    result = await ctx.core.escAware(
      async (abortController) => {
        return await forkChat(fullMessages, allTools, prompt, abortController.signal, 'none');
      },
      () => '' as const,
    );
  } catch (err) {
    ctx.core.verbose('reactivate', `forkChat failed: ${(err as Error).message}, skipping reactivation this turn`);
    return;
  }

  const evaluations = parseReactivationResult(result);
  if (!evaluations) {
    ctx.core.verbose('reactivate', 'forkChat returned non-JSON or non-array, skipping reactivation this turn');
    return;
  }

  for (const ev of evaluations) {
    // Per-entry type guards — skip malformed entries, keep going
    if (typeof ev.id !== 'number' || typeof ev.hash !== 'string' || typeof ev.reopen !== 'boolean') {
      continue;
    }
    if (!ev.reopen) continue;

    // Hash anti-hallusion: match by id AND hash. A hallucinated hash won't
    // match and the entry is silently skipped.
    const candidate = candidates.find((c) => c.id === ev.id && c.hash === ev.hash);
    if (!candidate) continue;

    // Reopen directly — the LLM does not decide; the system acts.
    const updated = ctx.todo.updateTodo(
      candidate.id,
      candidate.hash,
      candidate.name,
      false,
      candidate.note,
    );
    if (updated) {
      // The reopen decision is the LLM's judgment, not the system's — say so.
      // Fusing the evaluator's one-sentence grounds into the system voice made
      // the note read as "the system verified this condition", which it did
      // not: the hash check only proves the evaluator judged THIS todo. Keep
      // the user-defined trigger verbatim (the reader needs it to sanity-check
      // the reopen) but label it as the condition, and give the grounds their
      // own explicitly-attributed line instead of appending them bare.
      triologue.note(
        'SYSTEM',
        `Pinned todo #${candidate.id} "${candidate.name}" reactivated (evaluator judged its condition met). ` +
          `Condition: "${candidate.reactivate}".` +
          `${ev.reason ? `\nEvaluator's stated grounds: ${ev.reason}` : ''}`,
      );
    }
  }
}
