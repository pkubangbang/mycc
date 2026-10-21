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
import type { AugmentedToolCall } from '../../hook/hook-executor.js';
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
import { PRISTINE_BRIEF_RESULT } from '../triologue/recap-note.js';

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
  const comment = typeof recapArgs.comment === 'string' && recapArgs.comment.trim()
    ? recapArgs.comment.trim()
    : undefined;

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

  const anchor = triologue.getLastBrief();
  if (!anchor) {
    return fail('Error: No brief found to rewind to — nothing to collapse yet. Call brief first, then recap.');
  }

  // Nothing between the anchor and now (e.g. a recap right after a compaction,
  // whose resume brief IS the last brief). Skip both forks: there is nothing to
  // summarize, and consuming the floor anchor would be pointless churn.
  if (anchor.span.length === 0) {
    return fail('[RECAP] Nothing to collapse — there is no new activity past your last brief.');
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
    const abandonSize = triologue.recapNoteSize(description, abandonParts, anchor.id);
    if (abandonSize !== null && abandonSize > triologue.getResultThreshold()) {
      return fail(`Error: the recap note is ${abandonSize} chars, over the ${triologue.getResultThreshold()}-char tool-result limit; nothing was discarded. Re-run with a shorter comment.`);
    }
    const result = triologue.rewindToLastBrief(description, abandonParts, anchor.id);
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
  ctx.core.brief('info', 'recap', 'Summarizing the span since your last brief...');
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

  // ── SIZE PRE-CHECK: refuse an oversized note BEFORE touching the triologue ──
  // The note replaces the anchor brief's tool result, which is then the ONLY
  // record of the collapsed span. Reject here, while the store is still
  // untouched, so an oversized summary can never coexist with a truncation that
  // already threw the span away.
  const threshold = triologue.getResultThreshold();
  const noteSize = triologue.recapNoteSize(description, summary, anchor.id);
  if (noteSize !== null && noteSize > threshold) {
    ctx.core.brief('warn', 'recap',
      `Recap note too large (${noteSize} chars > ${threshold}). Nothing was collapsed.`,
    );
    return fail(`Error: the recap note is ${noteSize} chars, over the ${threshold}-char tool-result limit; nothing was collapsed. Re-run recap with a shorter summary or comment.`);
  }

  const result = triologue.rewindToLastBrief(description, summary, anchor.id);
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
        : PRISTINE_BRIEF_RESULT;
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