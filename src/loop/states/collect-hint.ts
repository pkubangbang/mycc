/**
 * collect-hint.ts - Hint-round generation for the COLLECT pipeline, owned by
 * a singleton.
 *
 * Step 3 of the COLLECT pipeline: when the confusion index crosses the
 * threshold, generate a hint round (LLM problem analysis → [HINT] note) and
 * handle its three outcomes. This module owns the step-3 policy layer:
 *  - the trigger gate (confusion index + minimum message count),
 *  - the confusion breakdown (including the objective dead-loop evidence that
 *    feeds the hint prompt's should_compact judgement),
 *  - the ESC-interruptible call into the hint-round generator
 *    (`triologue.generateHintRound` → `triologue/hint-round.ts`), and
 *  - the outcome handling (stop on ESC / compact on dead-loop / continue).
 *
 * Relationship to `triologue/hint-round.ts`: that module is the MECHANISM
 * (the LLM prompt, JSON schema, retry loop, validation, and [HINT] note
 * injection). This module is the POLICY that decides WHEN to call it and what
 * to do with the result. The facade method `Triologue.generateHintRound()` is
 * a thin delegation to the `HintRoundManager`, so the call chain is:
 *
 *     handleCollect → hintSuggester.runHintRound → triologue.generateHintRound
 *                   → getHintRoundManager().generate → HintRoundManager
 *
 * Owned by a singleton (`hintSuggester`), mirroring collect-skill.ts's
 * `skillSuggester` and the auto-state.ts precedent (a dedicated module owns
 * its feature's logic). Unlike `SkillSuggester`, the hint flow carries NO
 * per-turn throttle state of its own — its only dedup is the confusion index
 * (`ctx.core.resetConfusionIndex()`), which is cross-cutting state shared
 * with llm.ts / hook.ts / prompt.ts and therefore stays on `ctx.core`. So this
 * singleton exposes no `reset()` and the state machine does not touch it at
 * turn boundaries.
 *
 * See docs/hint-round-review.md for the full hint-round subsystem review.
 */

import type { MachineEnv, TurnVars } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import type { SequenceEvent } from '../../hook/sequence.js';

// Confusion threshold for hint generation
const CONFUSION_THRESHOLD = 10;
// Minimum message count before hint generation
const MIN_MESSAGES_FOR_HINT = 6;

/**
 * Generate a human-readable breakdown of confusion factors
 */
function generateBreakdown(
  _confusionIndex: number,
  events: SequenceEvent[]
): string {
  const parts: string[] = [];

  // Count assistant turns (inferred from events - each turn has multiple tools)
  // Estimate turns by counting unique tool call batches
  const turnCount = Math.ceil(events.length / 3); // rough estimate
  if (turnCount > 0) {
    parts.push(`${turnCount} assistant turns`);
  }

  // Count errors — only match error/failed/fatal at the start of the result
  // to avoid false positives from normal file content containing these words.
  // Keep 'includes' for OS error codes (ENOENT, EACCES, EPERM) which are
  // specific identifiers that won't appear in file content.
  const errors = events.filter(e => {
    const result = e.result?.toLowerCase() || '';
    return result.startsWith('error:') || result.startsWith('error ') ||
           result.startsWith('fatal:') || result.startsWith('failed:') ||
           result.startsWith('failed ') ||
           result.includes('enoent') || result.includes('eacces') ||
           result.includes('eperm') || result.includes('permission denied');
  });
  if (errors.length > 0) {
    parts.push(`${errors.length} tool errors`);
  }

  // Dead-loop evidence: same tool called 3+ times recently with the same error
  // prefix. Feeds the hint-round prompt instruction 8 so the LLM judges
  // should_compact on facts (a repeated-action line) rather than a vague
  // "the conversation feels long" feeling, which was over-triggering compact.
  const repeated = detectRepeatedActions(events);
  if (repeated) {
    parts.push(repeated);
  }

  return parts.length > 0 ? parts.join(', ') : 'No issues detected';
}

/**
 * Detect repeated tool actions that signal a dead-loop, to feed the hint
 * round as objective evidence (so the LLM judges should_compact on facts,
 * not on a vague "the conversation feels long" feeling).
 *
 * A "repeated action" = the same tool called 3+ times in the recent window
 * with results that share the same error-ish prefix. We look at the trailing
 * events (the recent window) and group consecutive same-tool calls; if 3+
 * share a common error prefix, we report it. Bash is keyed by its first
 * command clause (so repeated `pnpm test` runs group together even when the
 * tail differs); other tools are keyed by a stable arg (path/name/command).
 *
 * Returns a human-readable line like:
 *   "Repeated actions: edit_file ×4 (results start with "Error: old_text not found")"
 * or null if no repetition is found. The hint-round prompt (instruction 8)
 * tells the LLM to default should_compact=false when there is no such line.
 *
 * Exported for unit testing (see src/tests/loop/states/collect-repeated.test.ts).
 */
export function detectRepeatedActions(events: SequenceEvent[]): string | null {
  if (events.length < 3) return null;
  // Inspect only the trailing window — a dead-loop is a RECENT phenomenon.
  const window = events.slice(-8);
  // Group consecutive same-tool calls; report the largest group with 3+ that
  // also share an error prefix in their results.
  const groups: Array<{ tool: string; events: SequenceEvent[] }> = [];
  for (const ev of window) {
    const last = groups[groups.length - 1];
    if (last && last.tool === ev.tool) {
      last.events.push(ev);
    } else {
      groups.push({ tool: ev.tool, events: [ev] });
    }
  }
  let best: { tool: string; count: number; prefix: string } | null = null;
  for (const g of groups) {
    if (g.events.length < 3) continue;
    const prefix = commonErrorPrefix(g.events.map(e => e.result || ''));
    if (prefix) {
      const candidate = { tool: g.tool, count: g.events.length, prefix };
      if (!best || candidate.count > best.count) best = candidate;
    }
  }
  if (!best) return null;
  return `Repeated actions: ${best.tool} ×${best.count} (results start with "${best.prefix}")`;
}

/**
 * Find the longest common error prefix across results that look like errors.
 * Only considers results that start with an error-ish marker; if fewer than
 * 3 share a prefix, returns null (not a dead-loop signal).
 */
function commonErrorPrefix(results: string[]): string | null {
  const errorish = results.filter(r => {
    const lower = r.toLowerCase();
    return lower.startsWith('error:') || lower.startsWith('error ') ||
      lower.startsWith('failed') || lower.includes('not found') ||
      lower.includes('no such') || lower.includes('does not match');
  });
  if (errorish.length < 3) return null;
  // Longest common prefix of the first 40 chars (enough to identify the
  // repeated error class without dumping a whole message into the breakdown).
  const snippets = errorish.map(r => r.slice(0, 40));
  let prefix = snippets[0];
  for (const s of snippets) {
    while (prefix && !s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) break;
  }
  return prefix && prefix.length >= 6 ? prefix : null;
}

/** Signal returned by HintSuggester.runHintRound to steer the orchestrator. */
export type HintSignal = 'continue' | 'stop' | 'collect';

/**
 * HintSuggester - Singleton owning the COLLECT step-3 hint-round generation.
 *
 * Mirrors collect-skill.ts's `skillSuggester`: a dedicated module owns one
 * COLLECT step's logic, exposed as a process-wide singleton instance so the
 * state handler calls a method (`hintSuggester.runHintRound`) instead of a
 * free function. This singleton carries NO mutable state — the hint flow has
 * no per-turn throttle of its own (its dedup is the cross-cutting confusion
 * index on `ctx.core`), so there is nothing to `reset()` at a turn boundary
 * and the state machine never touches this instance.
 *
 * Lifetime: process-wide single instance. Child processes (teammates) do not
 * use this — a teammate's confusion handling mails the lead for guidance
 * (see teammate-worker.ts) rather than generating a hint round.
 */
export class HintSuggester {
  /**
   * Step 3: generate a hint round when confusion is high, and handle its
   * three outcomes.
   *
   * @returns `'stop'` if ESC aborted the hint round (caller returns STOP for
   *          centralized wrap-up); `'collect'` if the hint round signalled a
   *          dead-loop compaction (caller returns COLLECT to continue on
   *          compacted context); `'continue'` for a normal pass (or when the
   *          hint block was skipped).
   *
   * Side effects on `turn`: captures `lastHintFocus` (the hint source) on a
   * successful hint round; clears `collectTransientRetries` on compaction.
   */
  async runHintRound(env: MachineEnv, turn: TurnVars): Promise<HintSignal> {
    const { triologue, ctx } = env;
    const confusionIndex = ctx.core.getConfusionIndex();
    const messageCount = triologue.getMessagesRaw().length;

    if (confusionIndex < CONFUSION_THRESHOLD || messageCount < MIN_MESSAGES_FOR_HINT) {
      return 'continue';
    }

    // Use brief for hint round notification (user-facing)
    ctx.core.brief('info', 'loop', 'Generating hint...');
    const pendingSkills = env.conditions.getPending();
    const breakdown = generateBreakdown(confusionIndex, env.sequence.getEvents());

    // Use escAware for ESC-interruptible hint generation
    const result = await ctx.core.escAware(
      async (abortController) => {
        return await triologue.generateHintRound(abortController, confusionIndex, breakdown, pendingSkills);
      },
      () => {
        // ESC pressed during hint generation — return 'aborted' so the
        // caller returns STOP for centralized wrap-up (stop.ts handles
        // startWrapUp + auto-off + setNeglectedMode).
        return 'aborted' as const;
      }
    );

    // If aborted (ESC pressed), return STOP for centralized wrap-up.
    // Neglected mode is NOT cleared here — stop.ts handles that.
    if (result === 'aborted') {
      return 'stop';
    }
    // Capture focus_on from a successful hint round (hint source for the
    // composite keyword extraction in collect-skill.ts step 6). The
    // discriminated union carries focusOn only on the success path.
    if (result !== 'compact' && result.status === 'success') {
      turn.lastHintFocus = result.focusOn;
    }
    // If the LLM signalled should_compact (dead-loop or context stress),
    // trigger compaction now and CONTINUE the loop on fresh, compacted
    // context. Compaction is a mid-turn intervention (not a turn boundary),
    // so we return COLLECT (not STOP): COLLECT → LLM will retryChat on the
    // now-compacted triologue within the same turn. Returning STOP here was
    // the bug — STOP → PROMPT ends the turn and waits for user input, so the
    // loop stalled at PROMPT after a hint-compact. This mirrors the
    // hook-deferred compaction path (hook.ts sets deferredCompact → llm.ts
    // compacts and continues the while-loop).
    //
    // TP parity: compact() replaces the conversation with a 3-message
    // [summary_user, brief_assistant, brief_tool] resume sequence, so
    // getLastRole() is 'tool' — the next agent() (the real LLM response) is a
    // natural tool→assistant transition. Any note/user/tool the following
    // states inject starts from a legal role sequence. No special TP handling
    // needed here.
    //
    // Stat reset MUST mirror the llm.ts auto-compact branch: the stale
    // sequence events, embedding tracker, hook dedup cap, and crossroad
    // cooldown were all computed against the pre-compact history that no
    // longer exists. Without these resets, the continued loop would run on
    // corrupted stats (e.g. sequence events inflating the next confusion
    // score, hook dedup cap suppressing the next turn's hooks).
    if (result === 'compact') {
      ctx.core.brief('info', 'loop', 'Hint round signalled compaction (dead-loop / context stress); compacting...');
      const tools = loader.getToolsForScope(env.scope);
      await triologue.compact(undefined, undefined, tools);
      ctx.core.resetConfusionIndex();
      env.requestEmbeddingTracker.clear();
      // compactReset() clears session-level data ONLY (turn.events[] and
      // totalTurns survive — a turn spans across compaction). resetTurn()
      // re-arms per-turn hook dedup (same rationale as llm.ts auto-compact).
      env.sequence.compactReset();
      env.hookExecutor.resetTurn();
      env.crossroadOccurred = false;
      // Turn recovered via compaction — clear the transient-retry counter
      // so the next hiccup starts a fresh circuit-breaker count.
      turn.collectTransientRetries = 0;
      return 'collect';
    }
    // Reset confusion after hint
    ctx.core.resetConfusionIndex();
    return 'continue';
  }
}

/**
 * Process-wide singleton. Owns the COLLECT step-3 hint-round policy (gate +
 * breakdown + ESC wiring + outcome handling). Carries no mutable state — the
 * hint flow's only dedup is the cross-cutting confusion index on `ctx.core`.
 */
export const hintSuggester = new HintSuggester();
