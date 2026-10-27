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
import type { ProcessToolCallsResult } from '../../hook/hook-executor.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { agentIO } from '../agent-io.js';
import { loader } from '../../context/shared/loader.js';
import { handleRecapForks, commitMindmapPatch } from '../recap-rewind.js';
import { evaluateRecapSignal } from '../recap-signal.js';
import { shouldNoRecap } from '../../config.js';
import { applyPatchAction } from '../../mindmap/patch.js';
import { appendPatch, getPatchPath } from '../../mindmap/patch-jsonl.js';
import { loopEvents } from '../loop-events.js';
import { stripInternalMarkup } from '../../utils/letter-box.js';
import { buildCandidatesBrief } from '../crossroad.js';
import { briefToolCall, newBriefCallId, validateBriefIsolation } from '../triologue/brief.js';
import { formatOpenTodos } from '../triologue/recap-note.js';
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
export const MIN_RECAP_SUMMARY_CHARS = 40;

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

  // A fold has already answered this turn's worth of context: the reflection
  // describes work that auto-recap just collapsed, so writing it would attach
  // a stale analysis to a brief that now opens a new chunk. Skip it.
  if (chat.autoRecapFolded) return null;

  // The prefix is the pre-turn history: assistant(tool_calls) for THIS turn has
  // not been registered yet (see the caller), so it is fully answered.
  const note = await buildPlanScopeNote({
    messages: [...triologue.getMessages()],
    tools: loader.getToolsForScope(env.scope),
    briefMessage,
    briefCallId: briefCall.id,
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
  // The result is the plain `OK. <reflection>` — nothing is stamped, exactly as
  // the TOOL stage would leave it. This path answers the turn in HOOK and never
  // reaches handleTool, so it must write the same shape the model sees
  // everywhere else.
  triologue.tool('brief', withPlanScopeNote(note), briefCall.id);

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
 * AUTO-RECAP — step 4a: decide (outside the conversation) whether to fold.
 *
 * THE INVARIANT: rewind authority is external to the context being rewound.
 * The model used to choose (a `recap` tool it never called); an observer now
 * decides from the BRIEF STACK — `recap-signal.ts` reads one line per foldable
 * span plus current usage and answers fold / don't fold. This function is the
 * "apply" half: forks, rewrite, audit.
 *
 * WHY IT RUNS ON A `brief` TURN, AND BEFORE THAT BRIEF IS REGISTERED:
 *   1. the fork prefix must end on a COMPLETE round-trip. Here the current
 *      assistant message is not yet in the store, so the history ends on the
 *      previous brief's tool result — legal for strict providers. (In the TOOL
 *      stage it would be `assistant(tool_calls) → user`, which they reject.)
 *   2. the truncation therefore cannot touch the in-flight turn;
 *   3. the current brief then lands as the FIRST message of the new chunk:
 *
 *          [anchor + [RECAP] note] → [new brief] → work → (next fold) → …
 *
 *      which is the whole point — the LLM builds its context in chunks delimited
 *      by its own briefs, and the observer closes a chunk when it is finished.
 *
 * Returns VOID, never a HandlerResult: every failure path (no candidate, skip,
 * fork error, ESC, unaddressable target, over-size note) means "do not fold, run
 * the brief normally". A fold is an enhancement, never a dependency of a brief.
 */
async function handleAutoRecap(
  env: MachineEnv,
  turn: TurnVars,
  chat: ChatData,
  hookResult: ProcessToolCallsResult,
): Promise<void> {
  const { triologue, ctx } = env;

  // LEAD ONLY. Teammates keep their own loop (context/teammate-worker.ts) and
  // never reach this stage; the guard makes that structural rather than implicit.
  if (env.scope !== 'main') return;
  if (shouldNoRecap()) return;

  // THE TRIGGER: this turn is a brief turn. A fold undercuts the effort of the
  // brief just written — deliberately: the summary preserves it, and the brief
  // becomes the next chunk's opening.
  const briefCall = hookResult.calls.find((c) => c.function.name === 'brief');
  if (!briefCall || hookResult.blockedCalls.has(briefCall.id)) return;

  // The user pressed ESC, or a compaction is about to rewrite everything anyway.
  if (agentIO.isNeglectedMode()) return;
  if (hookResult.compactRequested || chat.deferredCompact) return;

  const candidates = triologue.getFoldCandidates();
  if (candidates.length === 0) {
    loopEvents.emit('auto_recap', { verdict: 'skip', reason: 'no foldable span yet' });
    return;
  }

  const verdict = await evaluateRecapSignal(
    candidates,
    { tokens: triologue.getTokenCount(), threshold: triologue.getTokenThreshold() },
    <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => ctx.core.escAware(fn, cleanup),
  );

  if (verdict.status !== 'recap') {
    loopEvents.emit('auto_recap', {
      verdict: verdict.status,
      reason: verdict.status === 'failed' ? 'signal failed' : verdict.reason,
      targetHash: candidates[candidates.length - 1]?.hash,
    });
    if (verdict.status === 'failed') {
      agentIO.verbose('recap', 'signal failed — nothing folded');
    } else {
      agentIO.verbose('recap', `signal skipped — ${verdict.reason}`);
    }
    return;
  }

  const target = candidates.find((c) => c.hash === verdict.target);
  if (!target) return; // defensive: evaluateRecapSignal only returns listed hashes

  // The peek: the span (what the forks need) and the CAS token they carry across
  // the await. Everything below re-resolves it — nothing here truncates directly.
  const anchor = triologue.getLastBrief(verdict.target);
  if (!anchor || anchor.span.length === 0) {
    loopEvents.emit('auto_recap', { verdict: 'skip', reason: 'anchor vanished before folding', targetHash: verdict.target });
    return;
  }

  // How many chunks this fold collapses: from the target to the newest foldable
  // span. Drives the "Summarizing last N chunks…" spinner text only.
  const targetIndex = candidates.findIndex((c) => c.hash === verdict.target);
  const chunks = candidates.length - targetIndex;

  // The prefix the forks reuse: the conversation BEFORE the current turn is
  // registered, plus the full tool schema the main loop already paid for.
  const fullMessages = [...triologue.getMessages()];
  const allTools = loader.getToolsForScope('main');

  const forks = await handleRecapForks({
    fullMessages,
    allTools,
    mindmap: ctx.core.getMindmap(),
    chunks,
  });

  if (forks.escCancelled) {
    loopEvents.emit('auto_recap', { verdict: 'skip', reason: 'ESC pressed — nothing folded', targetHash: verdict.target });
    return;
  }
  if (!forks.summary) {
    // The summary is required (there is no model behind it to retry by hand).
    // Nothing is collapsed: the span survives with its full detail.
    ctx.core.brief('warn', 'recap', `Fold skipped — ${forks.summaryError ?? 'no summary'}. Nothing was collapsed.`);
    loopEvents.emit('auto_recap', { verdict: 'failed', reason: forks.summaryError ?? 'no summary', targetHash: verdict.target });
    return;
  }

  // The note's two parts: the summary, then the live checklist (which lives
  // outside the transcript and would otherwise vanish with the span).
  const lastQuery = turn.lastUserQuery || undefined;
  const summaryBody = lastQuery
    ? `${forks.summary}

**User's last query (context):** ${lastQuery}`
    : forks.summary;
  const openTodos = formatOpenTodos(ctx.todo.getItems());

  // Size pre-check on the string the rewrite will ACTUALLY store. An over-size
  // note is written AFTER the truncation, so it must be refused while the store
  // is still untouched.
  const threshold = triologue.getResultThreshold();
  const noteSize = triologue.recapNoteSize(summaryBody, anchor.id, verdict.target, openTodos);
  if (noteSize !== null && noteSize > threshold) {
    ctx.core.brief('warn', 'recap', `Fold skipped — note is ${noteSize} chars, over the ${threshold} limit. Nothing was collapsed.`);
    loopEvents.emit('auto_recap', { verdict: 'skip', reason: 'note too large', targetHash: verdict.target });
    return;
  }

  const result = triologue.rewindToLastBrief(summaryBody, anchor.id, verdict.target, openTodos);
  if (!result) {
    // The anchor moved while the forks ran (compare-and-swap refused).
    ctx.core.brief('warn', 'recap', 'Fold skipped — the anchor moved. Nothing was collapsed.');
    loopEvents.emit('auto_recap', { verdict: 'skip', reason: 'anchor moved', targetHash: verdict.target });
    return;
  }

  // ── REPORT 1: the user-facing block ──
  // Same `recap` channel the old tool used, so the terminal rendering is the
  // familiar two-liner (first summary line + the token delta).
  const firstLine = forks.summary.split('\n').map((l: string) => l.trim()).find((l) => l.length > 0) ?? '';
  ctx.core.brief('info', 'recap',
    firstLine,
    `(${chalk.yellow(result.tokensBefore.toLocaleString())} → ${chalk.green(result.tokensAfter.toLocaleString())} tokens)`,
  );

  // ── REPORT 2: the audit record ──
  // A synthesized `steer` journal entry, NOT a store message: the note reached
  // the model as the anchor's rewritten tool result, so this record has no
  // message of its own to append — exactly the shape `submitUser(…, 'steer')`
  // exists for. `collateMessages` skips `steer`, so replay and livelog parity are
  // untouched, and appending a real user message here would break TP parity
  // (`tool → user` with the turn's assistant still unregistered).
  const anchorMessage = target.message.replace(/\s+/g, ' ').trim();
  const quoted = anchorMessage.length > 120 ? `${anchorMessage.slice(0, 119)}…` : anchorMessage;
  triologue.submitUser(
    `[RECAP] Folded ${target.spanMessages} message(s) / ~${target.spanTokens.toLocaleString()} tokens back to brief${quoted ? ` "${quoted}"` : ''} (${verdict.reason}).\nSummary: ${forks.summary}`,
    'steer',
  );

  // ── REPORT 3: the loop event ──
  loopEvents.emit('auto_recap', {
    verdict: 'recap',
    targetHash: verdict.target,
    reason: verdict.reason,
    foldedMessages: target.spanMessages,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  });

  // The patch is BEST-EFFORT and applied after the rewrite: a patch that cannot
  // be persisted must not undo a fold that already succeeded.
  if (forks.patchError) {
    ctx.core.brief('warn', 'mindmap-patch', `patch dropped (fold continues): ${forks.patchError}`);
  }
  if (forks.patch) {
    const mindmap = ctx.core.getMindmap();
    if (mindmap) {
      const applied = commitMindmapPatch(
        mindmap,
        forks.patch,
        getPatchPath(ctx.core.getWorkDir()),
        applyPatchAction,
        appendPatch,
      );
      ctx.core.brief(
        applied ? 'info' : 'warn',
        'mindmap-patch',
        `${forks.patch.action}: ${forks.patch.path}${forks.patch.title ? `/${forks.patch.title}` : ''}${applied ? '' : ' (rejected by validation — not persisted)'}`,
        forks.patch.reason || undefined,
      );
    }
  }

  // The turn's in-memory view of the conversation was just replaced:
  //  - lastBriefMessage pointed at text now folded away;
  //  - a plan-scope reflection on this same brief would describe folded work.
  turn.lastBriefMessage = result.anchorMessage;
  turn.nextBriefNudge = 5;
  chat.autoRecapFolded = true;
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

    // 4a. AUTO-RECAP — decide OUTSIDE the conversation whether to fold the work
    //     since an earlier brief. Runs BEFORE 4b because a fold answers this
    //     turn's worth of context: the plan-scope reflection describes the work
    //     that follows the brief, and a folded span makes it stale (4b checks
    //     `chat.autoRecapFolded`). Returns void — every failure means "don't
    //     fold, run the brief".
    await handleAutoRecap(env, turn, chat, hookResult);
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
        // Synthetic (see crossroadBrief) — the plain ack. With no model-facing
        // anchor line there is no privileged spelling left to withhold.
        : 'OK.';
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
        ctx.core.brief('info', 'crossroad',
          buildCandidatesBrief(chat.crossroadCandidates, chat.crossroadSelectedIndex ?? -1));
      }
      ctx.core.brief('info', 'crossroad', `Resolved: ${chat.crossroadContinuation}`);

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