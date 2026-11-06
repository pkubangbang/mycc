/**
 * stop-prevent-stop.ts - Pinned-todo STOP GUARD (the gate that may block the
 * end of a turn)
 *
 * WHAT A GUARD IS
 * ---------------
 * A pinned todo may carry a natural-language `preventStop` condition. It is a
 * STATEMENT about the state the work must reach ("tests for the todo module
 * pass and lint is clean"), not a reminder to be reopened. While it holds, the
 * agent is not allowed to finish its turn.
 *
 * WHERE IT RUNS
 * -------------
 * `stop.ts` calls `checkPreventStop()` after the neglection block (ESC always
 * wins — a user interrupt is never blocked) and BEFORE `presentResult()` and
 * the auto-mode early return. A hold returns COLLECT *without* calling
 * `markTurnBoundary()`, so the turn genuinely continues: turn.* events, hook
 * dedup counters and `totalTurns` all persist, and the LLM resumes with a
 * SYSTEM note explaining what is still missing.
 *
 * ONE BATCHED CALL
 * ----------------
 * Every guard is judged in a single `forkChat` with `toolChoice: 'none'`:
 * the full conversation prefix and tools schema are preserved (prompt-cache
 * hit), no tools are actually invoked, and one call per STOP is far cheaper
 * than one call per guard. The call is wrapped in `escAware` so ESC aborts it
 * immediately instead of pinning the state machine at STOP.
 *
 * WHAT THE HASH DOES — AND DOES NOT — PROVE
 * ------------------------------------------
 * The prompt shows each guard's `hash` and the verdict must echo `id` AND that
 * hash. This is NOT a defence against a hallucinated verdict: the model is
 * handed the string it is asked to copy, so an invented "held" verdict with the
 * copied hash verifies. What the hash actually buys is staleness detection — a
 * guard released, re-pinned or edited between the prompt and the verdict has a
 * different hash, so its verdict is voided instead of holding the turn on a
 * deadline that no longer exists. Do not re-claim more than that. The real
 * defence against confabulation is the escalation in `stop.ts`
 * (`TurnVars.preventStopHolds`) plus the EVIDENCE rule in the prompt.
 *
 * The gate never MUTATES the todo — it only reports.
 *
 * FAIL-OPEN
 * ---------
 * Every failure path (no guards, forkChat throws, non-JSON, malformed entry,
 * ESC) returns "no hold". A broken evaluator must never trap the agent in an
 * unbreakable loop; the residual risk of a model that keeps judging a guard as
 * held is handled by the escalation in `stop.ts` (see `TurnVars.preventStopHolds`)
 * and is documented in docs/loop/pinned-todo-prevent-stop.md.
 */

import type { MachineEnv } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { forkChat } from '../../engine/chat-provider.js';
import { startSpinner, stopSpinner } from '../../engine/chat-helpers.js';
import type { RetryConfig } from '../../engine/chat-helpers.js';

/**
 * Shape of a single guard verdict returned by the LLM via forkChat.
 */
interface PreventStopVerdict {
  id: number;
  hash: string;
  held: boolean;
  reason?: string;
  /**
   * Shape of the agent's FINAL assistant message (stall classification).
   * - 'complete' — a statement of finished work / result.
   * - 'blocked'  — a statement of a hard blocker (missing credential,
   *   destructive ambiguity, irreversible decision) that genuinely cannot
   *   proceed without the user.
   * - 'question' — a backward-ask to the user (preference / confirmation /
   *   "should I…?") instead of acting.
   * Optional: when absent or unparseable the gate falls back to the legacy
   * `held`-only behavior (fail-open — never trap the agent).
   */
  ending?: 'complete' | 'blocked' | 'question';
}

/** Outcome of the STOP gate. */
export interface PreventStopResult {
  /** True when at least one guard holds and the turn must not end. */
  held: boolean;
  /** The topmost held guard (lowest todo id), when `held` is true. */
  guard?: { id: number; name: string; condition: string };
  /** The evaluator's one-sentence grounds for the held guard. */
  reason?: string;
  /**
   * True when the hold is a STALL (a backward-ask with the goal unmet), not a
   * plain goal-unmet hold. Drives the `[STALL PREVENTED]` note in stop.ts.
   */
  stall?: boolean;
}

/** The value returned when nothing blocks the turn. */
const NO_HOLD: PreventStopResult = { held: false };

/**
 * Tight retry budget for the guard fork.
 *
 * The loop defaults (20s first token escalating to a 120s response cap over 3
 * retries) would let a hung endpoint hold the machine at STOP for minutes with
 * nothing on screen — the worst place to hang, since a held guard deliberately
 * does NOT return to the prompt. The defaults serve the MAIN loop, where
 * waiting makes progress; this fork only decides whether the turn may end, and
 * every failure path is already fail-open (NO_HOLD). Mirrors
 * CROSSROAD_RETRY_CONFIG (crossroad.ts) and PLAN_SCOPE_RETRY_CONFIG
 * (plan-scope.ts).
 */
const PREVENT_STOP_RETRY_CONFIG: Partial<RetryConfig> = {
  firstTokenTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  maxRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 3_000,
};

/**
 * Parse the forkChat result into a list of verdicts.
 *
 * Tolerant parsing: direct `JSON.parse` first; on failure, regex-extract the
 * first `[...]` JSON array and retry; on any failure or a non-array shape,
 * return null (the caller treats that as "no hold").
 *
 * Exported for unit testing.
 */
export function parsePreventStopResult(raw: string): PreventStopVerdict[] | null {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as PreventStopVerdict[];
    return null;
  } catch {
    // fall through to extraction
  }
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed as PreventStopVerdict[];
  } catch {
    // give up
  }
  return null;
}

/**
 * Evaluate every pinned todo's `preventStop` guard in one batched call.
 *
 * @returns `{ held: true, guard, reason }` when a guard holds (the turn must
 *   continue); `{ held: false }` in every other case, including every failure.
 */
export async function checkPreventStop(env: MachineEnv): Promise<PreventStopResult> {
  const { triologue, ctx } = env;
  const guards = ctx.todo.getPreventStopTodos();
  if (guards.length === 0) return NO_HOLD;

  // `id` is fixed (echoed back); `hash` is supplied by the LLM from the
  // conversation context so the anti-hallucination check stays active.
  const guardLines = guards.map(
    (g) => `- #${g.id} "${g.name}" [hash: ${g.hash}] — Guard: "${g.preventStop}"`,
  );
  const prompt = [
    'You are a STOP GUARD evaluator. Each item below is a condition the work MUST reach before the agent may finish its turn.',
    '',
    'Pinned todo guards:',
    ...guardLines,
    '',
    'Based on the conversation context above, decide for EACH guard whether it is STILL HELD —',
    'i.e. the required state has NOT yet been verifiably reached.',
    '',
    'ALSO classify the agent\'s FINAL assistant message (the reply that is about to end the turn):',
    '- "complete": a statement of finished work or a result.',
    '- "blocked": a statement of a HARD blocker (missing credential, destructive ambiguity, an irreversible',
    '  decision) that genuinely cannot proceed without the user.',
    '- "question": a BACKWARD-ASK to the user — a preference / confirmation / "should I…?" question',
    '  asked INSTEAD of acting.',
    '',
    'Reply with ONLY a JSON array, no other text. Schema:',
    '[',
    '  {"id": <todo_id>, "hash": "<hash of that guard>", "held": <true|false>, "ending": "<complete|blocked|question>", "reason": "<one sentence>"}',
    ']',
    '',
    'Rules:',
    '- "hash": copy the hash shown for that guard (a wrong hash voids the verdict).',
    '- "held": true when the required state is NOT satisfied yet, or you cannot verify it from the conversation.',
    '- "held": false only when the conversation contains concrete evidence the state was reached.',
    '- "ending": classify the final assistant message per the definitions above; omit if you cannot tell.',
    '- Judge EVIDENCE, not intent: the agent saying it will do something is not proof it did.',
    '- Echo exactly one entry per guard above.',
  ].join('\n');

  const fullMessages = triologue.getMessages();
  const allTools = loader.getToolsForScope(env.scope);

  let result: string;
  try {
    // ── SPINNER: this gate OWNS the wait indicator for its fork ──
    // forkChat is permanently noSpinner (see its header) and retryChat stopped
    // its own spinner in the provider's finally long before STOP, so without
    // this pair the terminal sits completely blank while a guard is judged —
    // exactly the state where the operator is most likely to think mycc hung,
    // because the turn was NOT allowed to end and no prompt has returned.
    // Same caller-owned, single-pair, `finally`-stopped discipline as
    // plan-scope (hook.ts), the recap fork (collapse.ts) and crossroad.
    // startSpinner no-ops in plain output with no TTY; stopSpinner is idempotent.
    startSpinner('Checking stop guards...');
    try {
      // escAware: a slow endpoint must not pin the machine at STOP, and ESC
      // (user interrupt) always wins over a guard. On ESC, return '' so parsing
      // yields null → fail-open.
      result = await ctx.core.escAware(
        async (abortController) => {
          return await forkChat(
            fullMessages, allTools, prompt, abortController.signal, 'none',
            PREVENT_STOP_RETRY_CONFIG,
          );
        },
        () => '' as const,
      );
    } finally {
      stopSpinner();
    }
  } catch (err) {
    ctx.core.verbose('prevent-stop', `forkChat failed: ${(err as Error).message}, allowing stop`);
    return NO_HOLD;
  }

  const verdicts = parsePreventStopResult(result);
  if (!verdicts) {
    ctx.core.verbose('prevent-stop', 'forkChat returned non-JSON or non-array, allowing stop');
    return NO_HOLD;
  }

  // Collect every actionable guard that verifies against a live guard
  // (id + hash), then report the topmost (lowest id) — one actionable guard
  // per STOP beats a wall of simultaneous holds.
  //
  // A guard is actionable when EITHER:
  //   (a) the evaluator judges the goal state still HELD (the classic
  //       goal-unmet hold), OR
  //   (b) STALL — the agent's final message is a backward-ask (ending ===
  //       'question') AND the evaluator did NOT affirm the goal met
  //       (held !== false). A question-ending must not let the turn park in
  //       AWAIT while the goal is unmet; that is the stall this feature
  //       exists to prevent.
  //
  // A 'blocked' ending (a HARD blocker: missing credential, destructive
  // ambiguity, an irreversible decision) is a LEGITIMATE stop — it short-
  // circuits to "allow stop" and OVERRIDES held, so the turn may end even
  // with the goal unmet. A 'question' ending with the goal verifiably met
  // (held === false) is likewise allowed to end.
  const held: Array<{ id: number; name: string; condition: string; reason?: string; stall: boolean }> = [];
  for (const v of verdicts) {
    if (typeof v.id !== 'number' || typeof v.hash !== 'string' || typeof v.held !== 'boolean') {
      continue;
    }
    const guard = guards.find((g) => g.id === v.id && g.hash === v.hash);
    if (!guard || !guard.preventStop) continue; // hallucinated hash / stale guard

    // A declared HARD blocker is a legitimate stop — never deflect it.
    if (v.ending === 'blocked') continue;

    const goalMet = v.held === false;
    const isQuestion = v.ending === 'question';
    // Stall: backward-ask while the goal is not verifiably met.
    const stall = isQuestion && !goalMet;
    // Hold: classic goal-unmet, OR a stall.
    const actionable = v.held || stall;
    if (!actionable) continue;

    held.push({
      id: guard.id,
      name: guard.name,
      condition: guard.preventStop,
      reason: typeof v.reason === 'string' ? v.reason : undefined,
      stall,
    });
  }

  if (held.length === 0) return NO_HOLD;

  held.sort((a, b) => a.id - b.id);
  const top = held[0];
  return {
    held: true,
    guard: { id: top.id, name: top.name, condition: top.condition },
    ...(top.reason ? { reason: top.reason } : {}),
    ...(top.stall ? { stall: true } : {}),
  };
}
