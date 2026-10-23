/**
 * hook.ts - HOOK state handler
 *
 * Augments raw tool calls with metadata, evaluates hook conditions,
 * registers the agent response with triologue, and branches to
 * TOOL (has calls) or STOP (no calls).
 *
 * META-TOOLS: recap is handled here (not as a regular tool)
 * because they need access to triologue which is not in AgentContext.
 * brief needs no dispatch — it runs as a regular tool — but its ISOLATION
 * (brief must be called alone) is enforced here, before hook processing.
 *
 * CROSSROAD: When crossroadContinuation is set on chat, the continuation is
 * merged into finalAssistantContent before triologue.agent() is called, and a
 * REMINDER note is injected after. No mutation of triologue internals occurs.
 * The flow goes to COLLECT so the LLM can regenerate tool calls.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import type { ToolCall } from '../../types.js';
import type { AugmentedToolCall, ProcessToolCallsResult } from '../../hook/hook-executor.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { agentIO } from '../agent-io.js';
import { loader } from '../../context/shared/loader.js';
import {
  validateRecapIsolation,
  handleRecapSpan,
} from '../recap-rewind.js';
import { applyPatchAction } from '../../mindmap/patch.js';
import { appendPatch, getPatchPath } from '../../mindmap/patch-jsonl.js';
import { loopEvents } from '../loop-events.js';
import { stripInternalMarkup } from '../../utils/letter-box.js';
import { buildCandidatesBrief } from '../crossroad.js';
import { briefToolCall, newBriefCallId, validateBriefIsolation } from '../triologue/brief.js';
import { briefReceiptLine, stampBriefResult } from '../triologue/recap-note.js';
import { buildPlanScopeNote, formatPlanScopeForDisplay, withPlanScopeNote } from '../plan-scope.js';

/**
 * Display the assistant's text content mid-loop via brief, stripping internal
 * DSML markup first. The LLM sometimes leaks DSML tool-call markup into the
 * content stream (see docs/providers/deepseek-api-pitfalls.md §6). The letter-box strips
 * at STOP, but these mid-loop briefs bypass it — without stripping here the
 * raw markup reaches the terminal. Content that is ENTIRELY DSML strips to
 * empty and is skipped (nothing displayable).
 */
function briefAssistantContent(
  ctx: MachineEnv['ctx'],
  content: string | undefined,
): void {
  if (!content) return;
  const stripped = stripInternalMarkup(content);
  if (stripped) {
    ctx.core.brief('info', 'assistant', stripped);
  }
}

/**
 * The minimum meaningful recap summary length (characters after trimming).
 *
 * A one-word "summary" ("ok", "done", "n/a") still records nothing: the whole
 * point of a recap is that the deleted span remains recoverable from the note,
 * so a note shorter than this is treated as "the fork produced no usable text"
 * rather than folded into the history as a successful collapse.
 */
const MIN_RECAP_SUMMARY_CHARS = 40;

/**
 * True when `summary` is real text a rewind may delete a span in favour of.
 *
 * Rejects the sentinels the fork can return or the caller can substitute:
 *   - '' / whitespace-only
 *   - '[RECAP] …' protocol lines ('No messages to summarize.', 'Cancelled: …')
 *     — the ESC one is handled upstream, but a future producer returning a
 *     protocol line must never be mistaken for content
 *   - the '(no summary)' placeholder recap-rewind.ts used to substitute for an
 *     empty fork (guarded there too, so an old call path cannot slip past)
 *   - anything below MIN_RECAP_SUMMARY_CHARS
 */
function hasUsableSummary(summary: string | undefined | null): boolean {
  const text = (summary ?? '').trim();
  if (text.length < MIN_RECAP_SUMMARY_CHARS) return false;
  if (text.startsWith('[RECAP]')) return false;
  if (text.toLowerCase() === '(no summary)') return false;
  return true;
}


/**
 * PLAN-mode brief enhancement: answer a `brief` turn with a reflection.
 *
 * WHY THE HOOK STAGE — the HOOK stage is where mycc augments what the model just
 * did, and it is the FIRST place in the turn where the brief call exists in a
 * forkable history: the assistant message carrying it has not been registered
 * yet (step 6 does that), so the messages handed to forkChat end on a complete
 * round-trip. The TOOL stage cannot offer that — there the assistant call is
 * already in the store while its result is not, and a fork would send
 * `assistant(tool_calls) → user`, which strict providers reject.
 *
 * WHAT IT PRODUCES — the brief's own tool result:
 *   tool('brief', "OK. When thinking on the larger scope, …", callId)
 * so it survives exactly as long as that brief's note slot does: the next recap
 * of this stretch OVERWRITES it with the span summary. That is the intended
 * one-shot lifetime — the reflection describes the work that FOLLOWS this brief.
 *
 * Returns null when nothing was done (not plan mode, no brief call, blocked
 * call, or any fork failure) — the caller then proceeds with the normal turn and
 * the brief executes exactly as before. A reflection never fails a brief.
 */
async function handlePlanScopeBrief(
  env: MachineEnv,
  chat: ChatData,
  hookResult: ProcessToolCallsResult,
): Promise<HandlerResult | null> {
  const { triologue, ctx } = env;
  if (ctx.core.getMode() !== 'plan') return null;

  const briefCall = hookResult.calls.find((c) => c.function.name === 'brief');
  if (!briefCall || hookResult.blockedCalls.has(briefCall.id)) return null;

  // ESC while planning: do not spend an LLM call the user just cancelled.
  if (agentIO.isNeglectedMode()) return null;

  const args = briefCall.function.arguments as Record<string, unknown> | undefined;
  const briefMessage = typeof args?.message === 'string' ? args.message : '';

  // The prefix is the pre-turn history: assistant(tool_calls) for THIS turn has
  // not been registered yet (see the caller), so it is fully answered.
  // ONE snapshot of the candidate list for both the budget and the stamp: the
  // assistant message is registered between them, which can change what counts
  // as open, so the two must read the same list rather than re-derive it.
  const openAnchors = triologue.listOpenAnchors();
  const note = await buildPlanScopeNote({
    messages: [...triologue.getMessages()],
    tools: loader.getToolsForScope(env.scope),
    briefMessage,
    briefCallId: briefCall.id,
    openAnchors,
    resultThreshold: triologue.getResultThreshold(),
    // The fork gets its OWN ESC-aware slot: it must be interruptible while it
    // runs, which the tool-execution wrapper cannot provide here.
    escAware: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) =>
      ctx.core.escAware(fn, cleanup),
  });
  if (!note) return null; // failed / cancelled / empty — run the turn normally

  // Register the FULL turn here (assistant call + its result), exactly like the
  // crossroad branch below, so the loop skips this call: the tool never runs and
  // TP parity holds (the round-trip is complete and last).
  triologue.agent(chat.assistantContent, chat.rawToolCalls as ToolCall[] | undefined, {
    reasoningContent: chat.assistantReasoningContent,
  });
  // The result is stamped with the ANCHOR LINE, exactly as the TOOL stage would
  // have done — this path answers the turn in HOOK and never reaches handleTool,
  // which is the only other place that stamps. Plan-mode briefs were therefore
  // the ONLY lead briefs without an anchor line, in the very mode where recap is
  // most recommended. Stamping here also lets the plan-scope reflection carry a
  // hash prefix in its result, so one writer still owns the rendering.
  const stamped = stampBriefResult(withPlanScopeNote(note), briefCall.id, openAnchors);
  triologue.tool('brief', stamped, briefCall.id);

  // The `brief` TOOL never runs on this path (the turn is answered above), so
  // its own prints are skipped too. Print them here, in the tool's exact shape,
  // or the user never sees what the agent actually said while planning.
  const confidence = typeof args?.confidence === 'number' ? args.confidence : undefined;
  if (briefMessage) {
    ctx.core.brief('info', 'brief', briefMessage,
      confidence === undefined ? undefined : `confidence: ${confidence * 10}%`);
    try {
      ctx.peer.recordBrief(briefMessage, confidence ?? 0);
    } catch {
      // Best-effort, exactly like brief.ts — heartbeat recording must never
      // break the brief path.
    }
  }

  // The reflection is its own block, not a note on the brief: the brief line
  // stays the user's text verbatim, and this block carries the STEP-BACK
  // analysis. Rendered with a heading rule so a multi-paragraph answer stays
  // readable instead of collapsing into one grey run of text.
  ctx.core.brief('info', 'plan-scope', formatPlanScopeForDisplay(note));

  // The turn is fully answered above (one assistant message, one result), so the
  // loop continues to the next LLM round. `brief` must be called alone
  // (validateBriefIsolation, step 2), so there is nothing else to dispatch.
  return AgentState.COLLECT;
}

/**
 * Handle a recap tool call.
 *
 * Recap collapses the conversation back to the LAST un-consumed brief (the
 * rewind anchor): everything after the brief's round-trip is replaced by a note
 * that is written INTO THE BRIEF'S OWN TOOL RESULT, in place —
 *
 *   tool('brief', "OK Note, a recap has reset the conversation here with summary: \"...\"")
 *
 * so the summary lives in a tool result, not in a fresh recap call, and a later
 * recap overwrites it. See Triologue.rewindToLastBrief().
 *
 * This handler only (a) validates args, (b) forks the summary + mindmap-patch
 * LLM calls over the span that is about to be deleted, and (c) hands the text
 * to the facade, which owns all message mutation.
 *
 * The two LLM forks run BEFORE the truncation (they need the pre-rewind
 * history as their cached prefix); nothing is written to the triologue until
 * both have finished, so an ESC mid-recap leaves the history untouched.
 */
async function handleRecapCall(
  call: AugmentedToolCall,
  env: MachineEnv,
  chat: ChatData,
  turn: TurnVars,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  // Show assistant text content if any
  briefAssistantContent(ctx, chat.assistantContent);

  const recapArgs = call.function.arguments as Record<string, unknown>;
  const description = typeof recapArgs.description === 'string' ? recapArgs.description.trim() : '';
  const abandon = recapArgs.abandon === true;
  // Optional anchor selector: the hash shown at the start of a brief result
  // (`[<hash>] ANCHOR — …`). Absent/empty → the default (newest solidified) anchor.
  const target = typeof recapArgs.target === 'string' && recapArgs.target.trim()
    ? recapArgs.target.trim()
    : undefined;
  const comment = typeof recapArgs.comment === 'string' && recapArgs.comment.trim()
    ? recapArgs.comment.trim()
    : undefined;

  // A refusal answers the call with a TOOL-CALL ERROR and COLLAPSES NOTHING:
  // the triologue is left byte-identical to before the attempt, and nothing is
  // written into any earlier brief's result. It needs no marking — anchor
  // scanning already knows the recap tool never produces activity (see
  // Triologue.hasMessagesAfterBrief).
  const fail = (message: string): HandlerResult => {
    triologue.agent(chat.assistantContent, chat.rawToolCalls as ToolCall[] | undefined, {
      reasoningContent: chat.assistantReasoningContent,
    });
    triologue.tool('recap', message, call.id);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  };

  if (!description) {
    return fail('Error: description is required and must be a non-empty string.');
  }

  // comment is REQUIRED: it determines the direction of the next turn.
  // (abandon path is exempt — it discards the span, no steering needed.)
  if (!abandon && !comment) {
    return fail('Error: comment is required (it determines the direction of the next turn). Provide a clear, actionable directive stating what should happen next.');
  }

  const anchor = triologue.getLastBrief(target);
  if (!anchor) {
    if (target && triologue.targetRefusal(target) === 'nothing-after') {
      // The hash DOES exist — it just has nothing after it yet (true of every
      // freshly printed anchor). Say that instead of "no brief matches", which
      // would deny the line the model is reading.
      return fail(`Error: the brief [${target}] has nothing after it yet — recap folds the work that follows an anchor, so it becomes foldable once new work lands below it. Call recap without target to collapse the span after the newest foldable anchor.`);
    }
    if (target) {
      // An EXPLICIT target never falls back: collapsing somewhere the model did
      // not choose would delete a span it meant to keep. Quote the hashes that DO
      // work — the set `target` accepts, not every brief that exists — so the
      // retry can pick a real anchor instead of a hash this same message refuses.
      const known = triologue.listBriefHashes(true).map((b) => `[${b.hash}]`).join(', ');
      // Never claim there are no briefs when there ARE — only none foldable yet.
      const all = triologue.listBriefHashes();
      const tail = known
        ? `. Addressable briefs: ${known}`
        : all.length > 0
          ? '. The briefs in this conversation all have nothing after them yet, so none is foldable.'
          : ', and this conversation has no briefs yet';
      return fail(`Error: No brief matches target "${target}"${tail}. Call recap without target to collapse to the newest foldable brief.`);
    }
    return fail('Error: No brief found to rewind to — nothing to collapse yet. Call brief first, then recap.');
  }

  // Nothing between the anchor and now (e.g. a recap right after a compaction,
  // whose resume brief IS the last brief). Skip both forks: there is nothing to
  // summarize, and consuming the floor anchor would be pointless churn.
  if (anchor.span.length === 0) {
    return fail('[RECAP] Nothing to collapse — no work has landed after the anchor yet.');
  }

  // ---- abandon path: collapse without summarizing ----
  if (abandon) {
    const parts: string[] = ['The work after the brief above was discarded without being summarized.'];
    if (turn.lastUserQuery) {
      parts.push('');
      parts.push(`**User's last query (context):** ${turn.lastUserQuery}`);
    }
    if (comment) {
      parts.push('');
      parts.push(`**Next direction (recap comment — follow this):** ${comment}`);
    }
    const abandonParts = parts.join('\n');
    // Size pre-check on the note that will ACTUALLY be written into the brief's
    // tool result (header + quoted anchor + body), not just the body: the write
    // happens AFTER the truncation, so an over-size note loses the span.
    const abandonSize = triologue.recapNoteSize(description, abandonParts, anchor.id, target);
    if (abandonSize !== null && abandonSize > triologue.getResultThreshold()) {
      return fail(`Error: the recap note is ${abandonSize} chars, over the ${triologue.getResultThreshold()}-char tool-result limit; nothing was discarded. Re-run with a shorter comment.`);
    }
    // Announce the discard BEFORE it happens: the collapse below is synchronous
    // and only its RESULT is reported at the end, so without this line the work
    // looks like a hang for as long as the collapse takes. Emitted AFTER the
    // size gate on purpose — a rejected recap must not announce a discard that
    // never happens.
    ctx.core.brief('info', 'recap', 'Discarding the span after the anchor...');
    const result = triologue.rewindToLastBrief(description, abandonParts, anchor.id, target);
    if (!result) {
      // The anchor moved between the peek at the top of this handler and here.
      // Answer the call rather than returning COLLECT with a dangling
      // tool_call and no result — that shape 400s on strict providers.
      return fail('Error: The last brief changed while collapsing, so nothing was discarded. Run recap again.');
    }
    ctx.core.brief('info', 'recap',
      `(${chalk.yellow(result.tokensBefore.toLocaleString())} → ${chalk.green(result.tokensAfter.toLocaleString())} tokens)`,
      `Abandoned: ${description}${comment ? ` — ${comment}` : ''}`,
    );
    turn.lastBriefMessage = result.anchorMessage;
    turn.nextBriefNudge = 5;
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // ---- normal path: summarize the span, then collapse ----
  // fullMessages + allTools form the cached prefix the main loop already paid
  // for — pass both un-minified and complete so the fork hits that cache.
  // (toolChoice:'none' is applied inside handleRecap; it constrains output to
  // text-only without touching the cached prefix.)
  const fullMessages = [...triologue.getMessages()];
  const allTools = loader.getToolsForScope('main');

  const escAware = <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T): Promise<T> => {
    return ctx.core.escAware(fn, cleanup);
  };
  const lastQueryForRecap = turn.lastUserQuery || undefined;

  // The durable one-line trace: the spinner started inside handleRecapSpan is
  // terminal-only (and cleared by its finally{}), so this brief is what
  // survives in the logs / Web UI as the record of the recap's silent wait.
  ctx.core.brief('info', 'recap', 'Summarizing the span after the anchor...');
  const mindmap = ctx.core.getMindmap();
  const { summary, patch, patchError } = await handleRecapSpan(
    fullMessages,
    anchor.span,
    allTools,
    description,
    mindmap,
    escAware,
    comment,
    lastQueryForRecap,
  );

  // Check for ESC cancellation — the triologue is still untouched at this point.
  if (summary.startsWith('[RECAP] Cancelled:')) {
    triologue.agent(chat.assistantContent, chat.rawToolCalls as ToolCall[] | undefined, {
      reasoningContent: chat.assistantReasoningContent,
    });
    triologue.tool('recap', summary, call.id);
    ctx.core.brief('warn', 'recap', summary);
    // ESC pressed during recap - return STOP for centralized wrap-up
    // (stop.ts handles startWrapUp + auto-off + setNeglectedMode).
    // Neglected mode is NOT cleared here. The cancelled note was already
    // registered as a tool response above, so triologue parity is intact.
    if (agentIO.isNeglectedMode()) {
      return AgentState.STOP;
    }
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // ── SUMMARY FLOOR: an empty summary must not truncate ──
  // The upper-bound check below exists because an over-size note loses the span
  // without recording it. The mirror-image failure loses the span AND the
  // knowledge: a fork that returns '' (provider hiccup, refusal, truncated
  // stream) would still delete everything after the anchor and leave a note
  // holding nothing but the header. Refuse — nothing truncated — and let the
  // model retry.
  if (!hasUsableSummary(summary)) {
    ctx.core.brief('warn', 'recap', 'Recap summary was empty — nothing was collapsed.');
    return fail('[RECAP] The summarization produced no usable text, so nothing was collapsed. Run recap again.');
  }

  // ── SIZE PRE-CHECK: refuse an oversized note BEFORE touching the triologue ──
  // The note replaces the anchor brief's tool result, which is then the ONLY
  // record of the collapsed span. Reject here, while the store is still
  // untouched, so an oversized summary can never coexist with a truncation that
  // already threw the span away.
  const threshold = triologue.getResultThreshold();
  const noteSize = triologue.recapNoteSize(description, summary, anchor.id, target);
  if (noteSize !== null && noteSize > threshold) {
    ctx.core.brief('warn', 'recap',
      `Recap note too large (${noteSize} chars > ${threshold}). Nothing was collapsed.`,
    );
    return fail(`Error: the recap note is ${noteSize} chars, over the ${threshold}-char tool-result limit; nothing was collapsed. Re-run recap with a shorter summary or comment.`);
  }

  const result = triologue.rewindToLastBrief(description, summary, anchor.id, target);
  if (!result) {
    // The anchor moved while the forks ran (a new brief landed) or vanished.
    // Nothing was truncated and nothing was appended.
    ctx.core.brief('warn', 'recap', 'Anchor moved during summarization — nothing was collapsed.');
    return fail('Error: The last brief changed while the recap was summarizing, so nothing was collapsed. Run recap again — it will rewind to the new anchor.');
  }

  ctx.core.brief('info', 'recap',
    `(${chalk.yellow(result.tokensBefore.toLocaleString())} → ${chalk.green(result.tokensAfter.toLocaleString())} tokens)`,
    `${description}${comment ? ` — ${comment}` : ''}`,
  );

  // Resync the in-turn brief memory with the anchor that survived the rewind:
  // the old lastBriefMessage pointed at a message the model can no longer see
  // (the span after the anchor's round-trip was just discarded).
  turn.lastBriefMessage = result.anchorMessage;
  turn.nextBriefNudge = 5;

  // Surface a dropped patch with the same vocabulary as a validation failure
  // below: the patch is best-effort and never fails the recap, but silence here
  // would make a mindmap update that never happened invisible.
  if (patchError) {
    ctx.core.brief('warn', 'mindmap-patch', `patch dropped (recap continues): ${patchError}`);
  }

  // ── Apply mindmap patch (if produced by forkChat #2) ──
  // Both the in-memory tree and the jsonl are updated simultaneously.
  // jsonl is the source of truth; in-memory is ephemeral (rebuilt from jsonl
  // at next startup). See docs/mindmap/mindmap-redesign.md Part 2.6.
  if (patch) {
    const mindmapForPatch = ctx.core.getMindmap();
    if (mindmapForPatch) {
      const applied = applyPatchAction(mindmapForPatch, patch);
      if (applied) {
        const patchPath = getPatchPath(ctx.core.getWorkDir());
        // appendPatch now returns false if the action fails structural
        // validation (orphan-prevention gate). Since applyPatchAction above
        // already accepted it, a false here signals logic drift between the
        // two validators — log it so the in-memory/jsonl divergence is visible.
        const persisted = appendPatch(patch, patchPath);
        if (persisted) {
          ctx.core.brief('info', 'mindmap-patch',
            `${patch.action}: ${patch.path}${patch.title ? `/${patch.title}` : ''}`,
            patch.reason || undefined,
          );
        } else {
          ctx.core.brief('warn', 'mindmap-patch',
            `rejected by validation (not persisted): ${patch.action} ${patch.path}${patch.title ? `/${patch.title}` : ''}`,
            patch.reason || undefined,
          );
        }
      }
    }
  }

  turn.isFirstRound = false;
  return AgentState.COLLECT;
}

export async function handleHook(
  env: MachineEnv,
  turn: TurnVars,
  chat: ChatData,
): Promise<HandlerResult> {
  const { triologue, ctx, hookExecutor } = env;

  try {
    // 1. Augment tool calls with metadata (file paths, LOC, destructive detection)
    const augmentedCalls = augmentToolCalls(chat.rawToolCalls);
    chat.augmentedCalls = augmentedCalls;

    // 2. Validate brief isolation (a brief turn is recap's rewind anchor, so it
    //    must stand alone — the whole turn is rejected, nothing partial runs).
    const briefValidation = validateBriefIsolation(augmentedCalls);
    if (!briefValidation.valid) {
      triologue.agent(chat.assistantContent, chat.rawToolCalls as ToolCall[] | undefined, {
        reasoningContent: chat.assistantReasoningContent,
      });
      for (const call of augmentedCalls) {
        triologue.tool(call.function.name, briefValidation.message!, call.id);
      }

      agentIO.log(chalk.yellow(`[brief] blocked: ${briefValidation.message}`));
      return AgentState.COLLECT;
    }

    // 2b. Validate recap isolation (must be called alone)
    const recapValidation = validateRecapIsolation(augmentedCalls);
    if (!recapValidation.valid) {
      triologue.agent(chat.assistantContent, chat.rawToolCalls as ToolCall[] | undefined, {
      reasoningContent: chat.assistantReasoningContent,
    });
      for (const call of augmentedCalls) {
        triologue.tool(call.function.name, recapValidation.message!, call.id);
      }

      agentIO.log(chalk.yellow(`[recap] blocked: ${recapValidation.message}`));
      return AgentState.COLLECT;
    }

    // 3. Process hooks (block/replace/inject/message) — moved before meta-tools
    //    so hooks can also fire on recap calls.
    const hookResult = await hookExecutor.processToolCalls(
      augmentedCalls,
      ctx,
      ctx.skill.getSkill.bind(ctx.skill),
    );
    chat.hookResult = hookResult;

    // Observability: emit hook_result (silent when no listeners)
    loopEvents.emit('hook_result', {
      blocked: hookResult.blockedCalls.size > 0,
      compactRequested: !!hookResult.compactRequested,
    });

    // 3.5. Handle compact request (highest priority — short-circuits all processing)
    //    DEFERRED: the actual compact runs at the LLM stage (see llm.ts), where
    //    `loader.getToolsForScope(scope)` is in scope and triologue.getMessages()
    //    is the exact cache prefix the next LLM call will use — so the forkChat
    //    inside compact() is a guaranteed cache hit. Compacting here (mid-HOOK)
    //    would have no tool list available, forcing a summary-only fallback and
    //    losing the working-memory benefit. We set a flag and reset the stale
    //    stat counts now; the LLM stage consumes the flag.
    if (hookResult.compactRequested) {
      ctx.core.brief('info', 'compact', 'Compacting context (deferred to LLM stage)...');
      chat.deferredCompact = true;

      // Reset stat counts now — the confusion that triggered the compact is
      // stale regardless of when the compact itself runs.
      // compactReset() clears session-level data ONLY (turn.events[] and
      // totalTurns survive — a turn spans across compaction).
      env.ctx.core.resetConfusionIndex();
      env.sequence.compactReset();
      env.crossroadOccurred = false;  // clear stale cooldown after compaction

      return AgentState.COLLECT;
    }

    // 4. Dispatch the recap meta-tool (rewind to the last brief)
    //    Guard against blocked meta-calls so the agent sees the rejection.
    const recapCall = hookResult.calls.find(c => c.function.name === 'recap');
    if (recapCall && !hookResult.blockedCalls.has(recapCall.id)) {
      return handleRecapCall(recapCall, env, chat, turn);
    }

    // 4b. PLAN-MODE SCOPE REFLECTION — a brief turn is a snapshot of the
    //     model's own thinking, so while PLANNING the loop answers it with one
    //     extra paragraph:
    //       tool('brief', "OK. When thinking on the larger scope, …", callId)
    //
    //     WHY HERE and not in the TOOL stage: at this point the assistant
    //     message carrying the brief call is NOT yet registered, so the fork
    //     sees a legal, fully-answered prefix. In the TOOL stage the assistant
    //     call is already in the store while its result is not, and a fork
    //     there would send `assistant(tool_calls) → user`, which strict
    //     providers reject (see the ledger note in triologue.ts). Same shape as
    //     the crossroad branch below: fork in HOOK, register both messages here,
    //     then let the loop skip that call.
    //
    //     The result is produced ONCE and registered here; the `brief` tool
    //     itself is untouched (it stays a plain reporter). Any failure — fork
    //     error, ESC, empty output, no room — falls through and the brief runs
    //     normally, so a reflection is never a dependency of a brief.
    const planScope = await handlePlanScopeBrief(env, chat, hookResult);
    if (planScope) return planScope;

    // 5. Crossroad: FIRST-CLASS branch — handled BEFORE normal registration.
    //    Emits a SINGLE triologue.agent() call with merged content + brief tool call
    //    to engage the LLM actively. The brief gives a thinking trace to follow,
    //    nudging the LLM to regenerate tool calls for the continued direction.
    //    Stop-trigger hooks that fired on the empty rawToolCalls are intentionally
    //    not carried forward — crossroad's purpose is to have the LLM regenerate
    //    tool calls after resolving its direction.
    if (chat.crossroadContinuation) {
      // Join with a space: the continuation is the genuinely new content that
      // follows the prefix's last sentence (the anchor was stripped during
      // generation). A space reads as natural prose continuation, whereas a
      // newline would create a visual paragraph break mid-sentence.
      const finalContent = `${chat.assistantContent || ''} ${chat.crossroadContinuation}`;
      // Use the shared writer's id convention (`crossroad_<ms>_<6 chars>`) so
      // every brief call in a transcript is greppable by prefix and minted the
      // same way. Hand-rolling here left crossroad ids unprefixed.
      const briefCallId = newBriefCallId('crossroad');
      // Mode-aware brief message. Neither branch uses a blanket "Continuing."
      // directive. A synthetic "Continuing." the LLM reads in its own triologue
      // is a self-approval signal: the agent treats it as consent to drift
      // forward past points where the user should review, instead of actively
      // re-orienting on the in-flight task (the same risk fixed in compact.ts,
      // hint-round.ts, and teammate-worker.ts — see commit 41e2fa8). Both
      // branches frame the brief as a refinement of the analysis only, leaving
      // the decision of the next step to the LLM:
      //   - Normal mode: "re-orient on the in-flight task and decide the next
      //     step" still nudges tool-call regeneration (deciding the next step
      //     naturally means emitting tool calls) without sanctioning drift.
      //   - Plan mode: a go-forward signal would contradict the plan-mode
      //     directive to stop and present the plan once analysis is done
      //     (buildPlanBasePrompt: "End your turn WITHOUT using any tools").
      //     The LLM would mistake "Continuing." for an instruction to keep
      //     exploring instead of presenting its plan, so we drop the forward
      //     nudge entirely.
      const inPlanMode = ctx.core.getMode() === 'plan';
      const briefMessage = inPlanMode
        ? 'Refining my analysis.'
        : 'Refining my approach. Let me re-orient on the in-flight task and decide the next step.';
      const crossroadBrief = briefToolCall(briefMessage, 7, briefCallId);
      triologue.agent(finalContent, [crossroadBrief], {
        reasoningContent: chat.assistantReasoningContent,
        synthetic: true,
      });

      // Inject the crossroad file path into the brief tool result so the LLM
      // knows where the full decision record lives. When there is no crossroad
      // file (e.g. file write failed), fall back to the pristine result.
      //
      // NOTE: we deliberately do NOT instruct the LLM to replay the crossroad
      // by default. Pretty-printing the crossroad is only needed when the user
      // explicitly asks to see the full reconstructed response; pushing it as a
      // default action wastes a turn and clutters the transcript. The LLM may
      // run `bash(command="mycc-pretty-print --type=crossroad <path>",
      // display=true)` if the user requests it — mycc-pretty-print merges
      // prefix + continuation to stdout; the display flag briefs stdout to the
      // terminal so the user sees the reconstructed response. Because the
      // display happens through a bash tool result (NOT chat.assistantContent),
      // detectTurningWord — which only scans chat.assistantContent — never sees
      // the reconstructed text, so replaying a crossroad cannot re-trigger it.
      const briefResult = chat.crossroadFilePath
        ? `A direction refinement was applied to your response. The full decision record is saved at: ${chat.crossroadFilePath} (you may replay it with mycc-pretty-print --type=crossroad <path> only if the user asks to see the full response).`
        // Synthetic (see crossroadBrief) — a receipt, never the anchor line: it
        // is not addressable, so naming a `recap(target=…)` call would lie.
        : briefReceiptLine(crossroadBrief.id);
      triologue.tool('brief', briefResult, crossroadBrief.id);

      // Three-part display, in reading order:
      //   1. prefix  — the content before the turning word (never shown live,
      //      because streaming content is collected, not printed, and this
      //      branch returns before the normal assistant brief at the bottom of
      //      the handler).
      //   2. best-of-three briefs — the candidate list (generation order, NOT
      //      reordered), with the selected one marked.
      //   3. outcome — the resolved continuation (the new direction).
      // The brief was previously emitted inside handleCrossroad's finally
      // (LLM stage), which put part 2 BEFORE part 1; building it here restores
      // the intended order.
      briefAssistantContent(ctx, chat.assistantContent);
      if (chat.crossroadCandidates && chat.crossroadCandidates.length > 1) {
        // ONE card, ONE label, ONE header: the resolved continuation rides in
        // the candidate list as its `**Outcome** — …` final line. It used to be
        // a second `brief('info', 'crossroad', 'Resolved: …')`, which rendered a
        // second `[crossroad]` header directly under the card and made one
        // logical block look split in two.
        //
        // DISPLAY ONLY: the model-visible triologue messages above (the merged
        // agent message + the brief tool result) are emitted before this point
        // and are NOT reordered — the LLM still reads prefix → refined
        // direction → its own brief result, exactly as before.
        ctx.core.brief('info', 'crossroad',
          buildCandidatesBrief(
            chat.crossroadCandidates,
            chat.crossroadSelectedIndex ?? -1,
            chat.crossroadContinuation,
          ));
      } else {
        // No candidate list (fewer than two drafts): the outcome is the only
        // thing to show, so it keeps the standalone line. RETAINED DELIBERATELY:
        // when there is no candidate list (`crossroadCandidates.length <= 1`)
        // this standalone `Resolved:` brief is the only signal that a direction
        // was chosen — it is not leftover from the card refactor, do not delete
        // it while folding the outcome into the card above.
        ctx.core.brief('info', 'crossroad', `Resolved: ${chat.crossroadContinuation}`);
      }

      // Inject deferred hook messages so the LLM sees them in the next round.
      // Each deferred message carries its originating hook name for attribution.
      for (const dm of hookResult.deferredMessages) {
        triologue.note('REMINDER', dm.hookName ? `Hook "${dm.hookName}" deferred this message: ${dm.message}` : dm.message, dm.hookName);
      }

      chat.crossroadContinuation = undefined;
      chat.crossroadFilePath = undefined;
      chat.crossroadCandidates = undefined;
      chat.crossroadSelectedIndex = undefined;
      return AgentState.COLLECT;
    }

    // 6. Normal agent registration (no crossroad — mutual exclusion ensured
    //    by the early return above).
    const finalAssistantContent = chat.assistantContent;
    const finalToolCalls =
      hookResult.calls.length > 0
        ? hookResult.calls.map((c) => ({ id: c.id, function: c.function }))
        : undefined;
    triologue.agent(
      finalAssistantContent,
      finalToolCalls as ToolCall[] | undefined,
      { reasoningContent: chat.assistantReasoningContent },
    );

    // Confusion scoring: +1 per assistant turn (agent spinning without progress)
    // In plan mode, the agent explores by reading files — tool calls are sparse,
    // so this +1 is the primary driver that ensures hints trigger.
    // In normal mode, tool calls are frequent enough to drive the hint on their own.
    if (ctx.core.getMode() === 'plan') {
      ctx.core.increaseConfusionIndex(1);
    }

    // Log blocked calls (tool responses are registered in tool.ts)
    if (hookResult.blockedCalls.size > 0) {
      for (const [callId, blockMessage] of hookResult.blockedCalls) {
        const name = hookResult.calls.find((c) => c.id === callId)?.function.name ?? 'unknown';
        agentIO.log(chalk.yellow(`[hook] blocked ${name}:\n${blockMessage}`));
      }
    }

    // No tool calls = all blocked or LLM produced none
    if (hookResult.calls.length === 0) {
      // Inject deferred hook messages so the LLM can respond to them
      // (e.g., lint-after-edit, test-after-edit block messages).
      // Each deferred message carries its originating hook name for attribution.
      if (hookResult.deferredMessages.length > 0) {
        for (const dm of hookResult.deferredMessages) {
          triologue.note('REMINDER', dm.hookName ? `Hook "${dm.hookName}" deferred this message: ${dm.message}` : dm.message, dm.hookName);
        }
        return AgentState.COLLECT;
      }
      return AgentState.STOP;
    }

    briefAssistantContent(ctx, chat.assistantContent);

    // From the second round onward, mute LLM text responses
    turn.isFirstRound = false;

    return AgentState.TOOL;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'hook', `HOOK state error: ${errorMessage}`);
    // If the user interrupted (neglected mode), route to STOP for centralized
    // wrap-up (stop.ts handles startWrapUp + auto-off + setNeglectedMode)
    // instead of dropping into PROMPT, which would prompt for new input mid-
    // interruption.
    if (agentIO.isNeglectedMode()) {
      return AgentState.STOP;
    }
    return AgentState.PROMPT;
  }
}