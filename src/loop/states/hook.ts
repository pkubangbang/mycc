/**
 * hook.ts - HOOK state handler
 *
 * Augments raw tool calls with metadata, evaluates hook conditions,
 * registers the agent response with triologue, and branches to
 * TOOL (has calls) or STOP (no calls).
 *
 * BRIEF: brief runs as a regular tool and may be batched with other calls in
 * the same turn. The former "brief must be called alone" gate
 * (validateBriefIsolation) was removed — batching no longer rejects the turn.
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
import type { ProcessToolCallsResult } from '../../hook/hook-executor.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { agentIO } from '../agent-io.js';
import { loader } from '../../context/shared/loader.js';
import { loopEvents } from '../loop-events.js';
import { stripInternalMarkup } from '../../utils/letter-box.js';
import { buildCrossroadCard, formatCrossroadCard, toCrossroadCardWire } from '../crossroad-card.js';
import { briefToolCall, newBriefCallId } from '../triologue/brief.js';
import { briefResultLine } from '../triologue/recap-note.js';
import { buildPlanScopeNote, formatPlanScopeForDisplay, withPlanScopeNote } from '../plan-scope.js';
import { startSpinner, stopSpinner } from '../../engine/chat-helpers.js';

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
 * so it rides with that brief's own result and is read alongside it: the
 * reflection describes the work that FOLLOWS this brief.
 *
 * Returns null when nothing was done (not plan mode, no brief call, blocked
 * call, or any fork failure) — the caller then proceeds with the normal turn and
 * the brief executes exactly as before. A reflection never fails a brief.
 */
/**
 * Inject every deferred hook message as a REMINDER note.
 *
 * ONE owner for the deferred-message queue: it used to be re-implemented at
 * each early-return site (crossroad branch, no-tool-calls branch), so a new
 * early return silently dropped the queue. Call this before EVERY return that
 * abandons the round without running the tool calls.
 */
function injectDeferredHookMessages(
  triologue: MachineEnv['triologue'],
  deferred: ProcessToolCallsResult['deferredMessages'],
  chat: ChatData
): void {
  if (deferred.length === 0) return;
  for (const dm of deferred) {
    triologue.note(
      'REMINDER',
      dm.hookName ? `Hook "${dm.hookName}" deferred this message: ${dm.message}` : dm.message,
      dm.hookName
    );
  }
  // The pass-scoped flag is how the no-calls branch knows a COLLECT loop-back
  // is owed (the queue itself is not consumed — hookResult is pass data and
  // the next pass replaces it).
  chat.hookFeedbackDelivered = true;
}

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
  //
  // ── SPINNER: this caller OWNS the wait indicator for the fork ──
  // forkChat is permanently noSpinner (see its header), and retryChat's own
  // spinner was stopped in the provider's finally before we reached HOOK — so
  // without this pair the terminal is completely blank for the whole
  // reflection: no brief line (printed below), no plan-scope block, nothing.
  // The crossroad fork is painted by its caller-owned pair in the LLM stage,
  // so plan-scope must paint its own.
  //
  // ONE pair, here at the caller — not inside plan-scope.ts, which is
  // documented pure I/O. The spinner is a NON-refcounted module global
  // (chat-helpers.ts): startSpinner no-ops if one is already running and
  // stopSpinner clears unconditionally, so ownership must be single and
  // outermost. `finally` guarantees we never leak a spinning line on throw or
  // on the early `if (!note) return null` below — which would otherwise leave
  // the cursor hidden and the terminal spinning into the next state.
  // startSpinner no-ops in plain output; stopSpinner is idempotent.
  let note: string | null;
  startSpinner('Reflecting on the larger scope...');
  try {
    note = await buildPlanScopeNote({
      messages: [...triologue.getMessages()],
      tools: loader.getToolsForScope(env.scope),
      briefMessage,
      resultThreshold: triologue.getResultThreshold(),
      // The fork gets its OWN ESC-aware slot: it must be interruptible while it
      // runs, which the tool-execution wrapper cannot provide here.
      escAware: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) =>
        ctx.core.escAware(fn, cleanup),
    });
  } finally {
    stopSpinner();
  }
  if (!note) return null; // failed / cancelled / empty — run the turn normally

  // Register the FULL turn here (assistant call + its result), exactly like the
  // crossroad branch below, so the loop skips this call: the tool never runs and
  // TP parity holds (the round-trip is complete and last).
  triologue.agent(chat.assistantContent, chat.rawToolCalls as ToolCall[] | undefined, {
    reasoningContent: chat.assistantReasoningContent,
  });
  triologue.tool('brief', withPlanScopeNote(note), briefCall.id);

  // The `brief` TOOL never runs on this path (the turn is answered above), so
  // its own prints are skipped too. Print them here, in the tool's exact shape,
  // or the user never sees what the agent actually said while planning.
  //
  // The model's PROSE comes first, in the same order every other path uses
  // (normal HOOK path and crossroad branch both call
  // briefAssistantContent before printing the tool's own line). This branch
  // used to print ONLY the brief message, so the sentence that explains WHY
  // the agent is briefing — already registered into the triologue above —
  // never reached the terminal: the user saw a bare "confidence: x%" line
  // attached to nothing. Ordering matters as much as presence: the brief line
  // must follow the prose it belongs to.
  briefAssistantContent(ctx, chat.assistantContent);
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
  // loop continues to the next LLM round: nothing else is left to dispatch.
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

    // 2. Process hooks (block/replace/inject/message).
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

    // 3. Handle compact request (highest priority — short-circuits all processing)
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

    // 4b. PLAN-MODE SCOPE REFLECTION — a brief turn is a snapshot of the
    // 4. model's own thinking, so while PLANNING the loop answers it with one
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
    if (planScope) {
      // The plan-scope branch abandons the round; the deferred queue still
      // has to reach the LLM, or a hook message is silently lost here.
      injectDeferredHookMessages(triologue, hookResult.deferredMessages, chat);
      return planScope;
    }

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
        : briefResultLine(crossroadBrief.id);
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
        // ONE structured event instead of two free-text notes: the card carries
        // the drafts, the winner and the resolved outcome, so the reader no
        // longer has to reconcile a candidate list with a separate
        // "Resolved: …" line. The plain-text body keeps the terminal (and the
        // replayed history) complete; a serve-mode client renders the rows.
        const card = buildCrossroadCard({
          candidates: chat.crossroadCandidates,
          selectedIndex: chat.crossroadSelectedIndex ?? -1,
          resolvedOutcome: chat.crossroadContinuation,
        });
        ctx.core.brief('info', 'crossroad', formatCrossroadCard(card), undefined, {
          crossroad: toCrossroadCardWire(card),
        });
      } else {
        // Only one direction survived — there is no card to compare, so the
        // outcome alone is the honest report.
        ctx.core.brief('info', 'crossroad', `Resolved: ${chat.crossroadContinuation}`);
      }

      // Inject deferred hook messages so the LLM sees them in the next round.
      // Each deferred message carries its originating hook name for attribution.
      injectDeferredHookMessages(triologue, hookResult.deferredMessages, chat);

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

    // Deferred hook messages are DELIVERED HERE (once) for the normal path, and
    // are drained by every early return above. Delivering them at this single
    // point — before the calls/STOP decision — means the round that runs tools
    // also carries the notes, and the round that cannot run tools still
    // returns to COLLECT once with them, instead of relying on tool.ts to
    // remember a third injection site.
    injectDeferredHookMessages(triologue, hookResult.deferredMessages, chat);

    // No tool calls = all blocked or LLM produced none
    if (hookResult.calls.length === 0) {
      // A round that carried hook feedback must go back to the LLM so it can
      // respond to it (e.g. lint-after-edit, test-after-edit block messages).
      if (chat.hookFeedbackDelivered === true) {
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