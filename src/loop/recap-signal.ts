/**
 * recap-signal.ts - The OBSERVER that decides whether to fold a span.
 *
 * WHY THIS EXISTS (the design the `recap` tool failed):
 *
 * Folding a finished span of work into a compact note is valuable, but it used
 * to be a TOOL the model had to CHOOSE to call (`recap(target_brief=…, summary=…)`).
 * It never chose. That is not a prompt defect — it is the same failure recorded
 * in the "pitfall" wiki domain for the earlier manual checkpoint tool: an actor
 * will not voluntarily rewind its own context, because the work it just did is
 * the thing it is most attached to.
 *
 * The invariant that replaces it:
 *
 *   REWIND AUTHORITY IS EXTERNAL TO THE CONTEXT BEING REWOUND.
 *   decided from the brief stack (outside the transcript),
 *   applied as a span rewrite  (inside the transcript).
 *
 * This module is the decider half. It reads the brief stack as a COMPACT,
 * QUANTITATIVE list — never the conversation itself — and returns a verdict:
 * fold to brief X, or leave it alone. `states/hook.ts` step 4a then runs the
 * forks and the rewrite.
 *
 * WHY A DEDICATED retryChat AND NOT A forkChat:
 *
 * A fork reuses the conversation prefix to hit the prompt cache, which means
 * sending the whole conversation to decide something about it. The signal has
 * the opposite requirement — its whole point is to judge the SHAPE of the
 * session (how many chunks, how big, how full the context is) without paying
 * for, or being distracted by, the content. So it is a separate small context:
 * one line per candidate plus the usage figure. It is UNCACHED by design; a few
 * hundred tokens per qualifying brief turn is the price of the decision, and the
 * two forks it can trigger are the ones that reuse the cache.
 *
 * THE HASH IS INTERNAL. The model never sees a brief hash any more (§ "remove
 * the anchor vocabulary" in docs/loop/auto-recap-plan.md): brief results are a
 * plain `OK.`. The signal sees hashes because it is an observer and needs to
 * name a target; the caller resolves the hash back to a call id and hands THAT
 * to `rewindToLastBrief` as the compare-and-swap token.
 */

import type { Tool } from '../types.js';
import { retryChat, MODEL } from '../engine/chat-provider.js';
import { startSpinner, stopSpinner, StreamAbortedError } from '../engine/chat-helpers.js';

/**
 * One foldable chunk boundary, as the signal sees it.
 *
 * Mirrors `Triologue.getFoldCandidates()` — the loop hands the array straight
 * through, so the two must not drift.
 */
export interface FoldCandidate {
  /** Opaque key the caller resolves back to a brief call id. */
  hash: string;
  /** The brief's own message — the only content the signal reads. */
  message: string;
  /** The brief's tool-call id (compare-and-swap token for the rewind). */
  id: string;
  /** Messages after the brief's round-trip — exactly the region a fold deletes. */
  spanMessages: number;
  /** Estimated tokens of that region (`chars / 4`, the project-wide estimate). */
  spanTokens: number;
}

/** Current context usage, so the signal can weigh "how full are we". */
export interface RecapSignalUsage {
  tokens: number;
  threshold: number;
}

/**
 * The signal's answer. Three cases the caller MUST distinguish:
 *
 *   - `recap`  — fold to `target` (a hash from the candidate list).
 *   - `skip`   — the model looked and said no. A deliberate, settled answer.
 *   - `failed` — the call threw (network, retry budget). NOT a decision: the
 *                span stays, the difference is observable, and `reason`
 *                carries the CAUSE so the one channel meant to diagnose the
 *                signal is not reduced to a bare "failed".
 *
 * ESC is a FOURTH case, and it is its own status on purpose: a cancelled
 * decision is neither a decision nor a fault, and the caller must send the
 * model back to PROMPT rather than let the turn continue as if nothing
 * happened.
 */
export type RecapSignal =
  | { status: 'recap'; target: string; reason: string }
  | { status: 'skip'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'esc' };

/** Per-message character budget in the signal prompt (keeps the context small). */
const MESSAGE_CLIP = 200;

/** The forced tool that carries the verdict — structured output, no text parsing. */
const DECIDE_RECAP_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'decide_recap',
    description: 'Decide whether a finished span of the session should be folded into a summary note',
    parameters: {
      type: 'object',
      properties: {
        recap: {
          type: 'boolean',
          description: 'true to fold the span after the chosen brief; false to leave the transcript untouched',
        },
        target_brief: {
          type: 'string',
          description:
            'When recap=true, the hash of the brief to fold back to (from the list). Prefer the OLDEST brief whose span still describes useful, finished work. Ignored when recap=false.',
        },
        reason: {
          type: 'string',
          description: 'One short sentence: why fold (or why not). Shown to the user.',
        },
      },
      required: ['recap', 'reason'],
    },
  },
};

/** Clip and flatten a brief message so one runaway brief cannot bloat the prompt. */
function clipMessage(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= MESSAGE_CLIP ? flat : `${flat.slice(0, MESSAGE_CLIP - 1)}…`;
}

/** `1234` → `1.2k`; keeps the list narrow without losing scale. */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * The system prompt. Deliberately STATES THE TRADE-OFF: the decider must know
 * both what a fold buys (room, a durable record of finished work) and what it
 * costs (detail is gone; only the summary survives), or it degenerates into
 * "always fold" or "never fold".
 */
const SIGNAL_SYSTEM_PROMPT = `You are the context manager of a coding agent. The agent reports progress with \`brief\` calls; each brief is a boundary that divides its session into chunks of work ("spans"). You decide whether the work in some span is FINISHED enough to be replaced by a summary note, freeing context for what comes next.

The agent cannot make this decision for itself — it is attached to the work it just did — so you make it from the shape of the session, never from the content of the transcript.

You will see, in timely order (oldest first), every span that could be folded: the brief that opened it, and the size of the work after it. You will also see how full the context is.

FOLD when:
- the span's work reached a conclusion (a feature landed, a question was answered, a decision was settled), and later briefs describe work that supersedes or continues independently of it; or
- the context is filling up, and the oldest span is finished even though a newer one is still in flight.

DO NOT FOLD when:
- the span is still in use: the next step depends on its exact details (file paths, line numbers, error text) that a summary would lose;
- the span is a dead end that later briefs already abandoned in a different direction and the note would only mislead;
- nothing after the last brief looks finished.

Prefer the OLDEST brief whose span is finished: folding an old span frees the most context and keeps the most recent work intact. Folding several spans in a row is expected as the session grows: each fold consumes its target, so the next one naturally reaches further back.

Answer with the decide_recap tool ONLY.`;

/**
 * Render the candidate list — the signal's entire view of the session.
 *
 * ONE LINE PER CANDIDATE, oldest first, so the model reads the session the way
 * it happened. Sizes are on the same scale as the usage line, which is what
 * lets "the oldest span is 14k of our 47k" be a judgement the model can make.
 */
function buildSignalUserMessage(
  candidates: readonly FoldCandidate[],
  usage: RecapSignalUsage,
): string {
  const lines = candidates.map((c) => {
    const size = `after it: ${c.spanMessages} msg${c.spanMessages === 1 ? '' : 's'} / ~${formatTokens(c.spanTokens)} tok`;
    return `[${c.hash}] "${clipMessage(c.message)}"  ${size}`;
  });
  const pct = usage.threshold > 0 ? Math.round((usage.tokens / usage.threshold) * 100) : 0;
  return [
    'Spans that could be folded (oldest first):',
    lines.join('\n'),
    '',
    `Context usage: ${formatTokens(usage.tokens)} / ${formatTokens(usage.threshold)} tokens (${pct}%).`,
  ].join('\n');
}

/**
 * Parse the forced tool call into a verdict, resolving `target_brief` against
 * the candidate list.
 *
 * A `recap: true` that names no candidate (missing, mistyped, or a hash of a
 * brief that is not foldable) degrades to `skip` — NEVER to a default target.
 * Folding somewhere the decider did not choose would delete a span it meant to
 * keep, which is the one failure this whole design must not have.
 */
function parseVerdict(
  toolCalls: Array<{ function?: { arguments?: unknown } }> | undefined,
  candidates: readonly FoldCandidate[],
): RecapSignal {
  const raw = toolCalls?.[0]?.function?.arguments;
  if (raw === undefined) return { status: 'skip', reason: 'signal returned no verdict' };

  let args: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { status: 'skip', reason: 'signal returned malformed JSON' };
    }
  } else {
    args = (raw ?? {}) as Record<string, unknown>;
  }
  // `JSON.parse('null')` succeeds and yields null — a non-object body must not
  // reach the property reads below (a TypeError there would surface as a
  // cause-free `failed` instead of the documented skip).
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { status: 'skip', reason: 'signal returned a non-object verdict' };
  }

  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (args.recap !== true) {
    return { status: 'skip', reason: reason || 'no reason given' };
  }

  const target = typeof args.target_brief === 'string'
    ? args.target_brief.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
    : '';
  const match = candidates.find((c) => c.hash.toLowerCase() === target);
  if (!match) {
    // An unaddressable target is a SKIP, not a retry: the retry budget was
    // already spent inside retryChat, and the safe direction for a missing
    // target is "leave the transcript alone".
    return {
      status: 'skip',
      reason: `signal named an unknown brief "${target || '(none)'}" — nothing folded`,
    };
  }

  return { status: 'recap', target: match.hash, reason: reason || 'span complete' };
}

/**
 * Decide whether to fold, from the brief stack alone.
 *
 * @param candidates - `Triologue.getFoldCandidates()`, oldest → newest. EMPTY is
 *        a valid input and short-circuits to `skip` without an LLM call
 *        (nothing can be folded).
 * @param usage - current tokens vs threshold (`Triologue.getTokenCount()` /
 *        `getTokenThreshold()`), so the decider can weigh the cost of growing.
 * @param escAware - the lead's ESC-aware runner; the whole call is
 *        interruptible, and an ESC aborts it (reported as `esc` — no fold).
 * @returns A {@link RecapSignal}. NEVER throws: a failed signal leaves the
 *          turn intact and the brief must still run.
 */
export async function evaluateRecapSignal(
  candidates: readonly FoldCandidate[],
  usage: RecapSignalUsage,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<RecapSignal> {
  // Nothing to fold to: a fresh session, or a session whose only briefs have
  // nothing after them. No LLM call, no spinner, no "failure".
  if (candidates.length === 0) {
    return { status: 'skip', reason: 'no foldable span yet' };
  }

  const request = {
    model: MODEL,
    messages: [
      { role: 'system' as const, content: SIGNAL_SYSTEM_PROMPT },
      { role: 'user' as const, content: buildSignalUserMessage(candidates, usage) },
    ],
    tools: [DECIDE_RECAP_TOOL],
    tool_choice: 'required' as const,
  };
  // TWO retries (three attempts): this is a structured-output call that must
  // produce a tool call, and a single attempt gives up on a transient blip for
  // no benefit — the failure mode of a retry here is a few hundred tokens.
  const config = { noSpinner: true, maxRetries: 2 };

  try {
    // retryChat paints nothing with noSpinner, so the caller-visible wait
    // indicator is OURS. One pair, wrapped around the whole call (including its
    // internal retries) — a per-attempt pair would flicker.
    startSpinner('Managing the context');
    const run = (signal: AbortSignal): Promise<{ message?: { tool_calls?: unknown } }> =>
      retryChat(request, { ...config, signal }) as unknown as Promise<{
        message?: { tool_calls?: unknown };
      }>;

    const response = escAware
      ? await escAware(
          (ac) => run(ac.signal),
          () => null as { message?: { tool_calls?: unknown } } | null,
        )
      : await run(new AbortController().signal);

    // ESC: the user cancelled the decision. Its OWN status — a cancellation is
    // not a fault to be retried and not a "skip" to be recorded as settled.
    if (!response) return { status: 'esc' };
    const toolCalls = response.message?.tool_calls as
      | Array<{ function?: { arguments?: unknown } }>
      | undefined;
    return parseVerdict(toolCalls, candidates);
  } catch (err) {
    // An aborted stream (ESC pressed while the model was replying) arrives as a
    // THROWN abort, not as the escAware cleanup value — same outcome, same
    // status: the user stopped the turn.
    if (isAbortError(err)) return { status: 'esc' };
    // Network fault, retry budget exhausted, auth error, wrong model, 402, or an
    // aborted stream. NOT a decision — reported as `failed` so the caller can
    // tell it apart from a deliberate skip, and WITH THE CAUSE: this is the only
    // channel that can diagnose why the signal never decided.
    return { status: 'failed', reason: describeError(err) };
  } finally {
    stopSpinner();
  }
}

/** True for the abort flavours the engines raise when a stream is cancelled. */
function isAbortError(err: unknown): boolean {
  if (err instanceof StreamAbortedError) return true;
  if (err instanceof Error) {
    return err.name === 'AbortError' || /aborted|abort(ed)? by/i.test(err.message);
  }
  return false;
}

/**
 * One short, cause-carrying description of a thrown error.
 *
 * The `failed` verdict is the ONLY channel that can explain why the signal did
 * not decide, so the cause is carried instead of being collapsed into a bare
 * `{ status: 'failed' }` — an auth error, a wrong model name, and a 402 used to
 * be indistinguishable there.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}
