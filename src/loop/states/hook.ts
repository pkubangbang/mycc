/**
 * hook.ts - HOOK state handler
 *
 * Augments raw tool calls with metadata, evaluates hook conditions,
 * registers the agent response with triologue, and branches to
 * TOOL (has calls) or STOP (no calls).
 *
 * META-TOOLS: checkpoint and recap are handled here (not as regular tools)
 * because they need access to triologue which is not in AgentContext.
 *
 * CROSSROAD: When crossroadContinuation is set on pass, the continuation is
 * merged into finalAssistantContent before triologue.agent() is called, and a
 * REMINDER note is injected after. No mutation of triologue internals occurs.
 * The flow goes to COLLECT so the LLM can regenerate tool calls.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { ToolCall } from '../../types.js';
import type { AugmentedToolCall } from '../../hook/hook-executor.js';
import { augmentToolCalls } from '../../hook/hook-preprocessor.js';
import { agentIO } from '../agent-io.js';
import { loader } from '../../context/shared/loader.js';
import {
  validateCheckpointIsolation,
  validateRecapIsolation,
  handleCheckpoint,
  handleRecapWithPatch,
  type CheckpointContext
} from '../checkpoint-recap.js';
import { applyPatchAction } from '../../mindmap/patch.js';
import { appendPatch, getPatchPath } from '../../mindmap/patch-jsonl.js';
import { loopEvents } from '../loop-events.js';

/**
 * Create checkpoint context from machine environment
 */
function createCheckpointContext(env: MachineEnv): CheckpointContext {
  return {
    core: env.ctx.core,
    todo: env.ctx.todo,
    triologue: env.triologue,
  };
}

/**
 * Handle a checkpoint tool call.
 * Creates a checkpoint marker, registers the tool response with triologue,
 * and returns to COLLECT for the next round.
 */
async function handleCheckpointCall(
  call: AugmentedToolCall,
  env: MachineEnv,
  pass: PassData,
  turn: TurnVars,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  // Execute checkpoint using shared handler
  const checkpointCtx = createCheckpointContext(env);
  const result = handleCheckpoint(
    call.function.arguments as Record<string, unknown>,
    checkpointCtx,
  );

  // Register the assistant message with tool calls
  triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);

  // Add tool response (checkpoint info is in the tool result — no note needed)
  triologue.tool('checkpoint', result.result, call.id);

  if (pass.assistantContent) {
    ctx.core.brief('info', 'assistant', pass.assistantContent);
  }

  turn.isFirstRound = false;
  return AgentState.COLLECT;
}

/**
 * Handle a recap tool call.
 * The full triologue (pre-truncation) is passed to the LLM for summarization,
 * then the entire checkpoint span (assistant→checkpoint-tool→subtask→recap) is
 * replaced by an artificial agent() + tool() pair preserving natural tool-call flow.
 */
async function handleRecapCall(
  call: AugmentedToolCall,
  env: MachineEnv,
  pass: PassData,
  turn: TurnVars,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  // Show assistant text content if any
  if (pass.assistantContent) {
    ctx.core.brief('info', 'assistant', pass.assistantContent);
  }

  // Validate and extract checkpoint
  const recapArgs = call.function.arguments as Record<string, unknown>;
  const checkpointId = recapArgs.checkpoint_id as string;
  const abandon = recapArgs.abandon === true;
  const comment = typeof recapArgs.comment === 'string' && recapArgs.comment.trim()
    ? recapArgs.comment.trim()
    : undefined;

  if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim() === '') {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    triologue.tool('recap', 'Error: checkpoint_id is required and must be a non-empty string.', call.id);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // comment is REQUIRED: it determines the direction of the next turn.
  // (abandon path is exempt — it discards the checkpoint, no steering needed.)
  if (!abandon && !comment) {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    triologue.tool('recap', 'Error: comment is required (it determines the direction of the next turn). Provide a clear, actionable directive stating what should happen next.', call.id);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  const checkpoint = triologue.findCheckpointById(checkpointId);
  if (!checkpoint) {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    const allCheckpoints = triologue.findAllCheckpoints();
    const msg = allCheckpoints.length === 0
      ? 'Error: No checkpoint found.'
      : `Error: Checkpoint "${checkpointId}" not found. Available: ${allCheckpoints.map(cp => `[${cp.id}: ${cp.description}]`).join(', ')}`;
    triologue.tool('recap', msg, call.id);
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  const tokensBefore = triologue.getTokenCount();

  if (abandon) {
    // Truncate at the assistant that called checkpoint — removes entire span.
    triologue.recapMessages(checkpoint.index);

    // Inject artificial assistant + tool result instead of note(),
    // so the triologue maintains natural tool-call flow.
    // Order: desc → todo note → original direction (heuristic) → LUQ (context) → comment (steering, last).
    const abandonParts: string[] = [];
    abandonParts.push(`[RECAP] Abandoned checkpoint "${checkpoint.description}".`);
    abandonParts.push('');
    abandonParts.push('Note: the checkpoint todo item was auto-created with this checkpoint\'s ID as its note. Use todo_update to mark it as done.');
    if (checkpoint.if_abandoned) {
      abandonParts.push('');
      abandonParts.push(`**Original direction (from checkpoint creation):** ${checkpoint.if_abandoned}`);
      abandonParts.push('Compare the original direction with the context below and find your path.');
    }
    if (turn.lastUserQuery) {
      abandonParts.push('');
      abandonParts.push(`**User's last query (context):** ${turn.lastUserQuery}`);
    }
    if (comment) {
      abandonParts.push('');
      abandonParts.push(`**Next direction (recap comment — follow this):** ${comment}`);
    }
    const noteContent = abandonParts.join('\n');

    triologue.agent('', [{
      id: call.id,
      function: {
        name: 'recap',
        arguments: call.function.arguments,
      },
    }]);
    triologue.tool('recap', noteContent, call.id);

    const tokensAfter = triologue.getTokenCount();
    ctx.core.brief('info', 'recap',
      `(${chalk.yellow(tokensBefore.toLocaleString())} → ${chalk.green(tokensAfter.toLocaleString())} tokens)`,
      `Abandoned: ${checkpoint.description}${comment ? ` — ${comment}` : ''}`
    );

    // Close the auto-created checkpoint todo
    ctx.todo.closeCheckpointTodo(checkpointId);

    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // Normal: capture full triologue BEFORE truncation for the LLM
  // fullMessages + allTools form the cached prefix the main loop already paid
  // for — pass both un-minified and complete so the fork hits that cache.
  // (toolChoice:'none' is applied inside handleRecap; it constrains output to
  // text-only without touching the cached prefix.)
  const fullMessages = [...triologue.getMessages()];
  const allTools = loader.getToolsForScope('main');

  // Extract the original checkpoint tool result from fullMessages for "before state" context
  let checkpointResult: string | undefined;
  for (const msg of fullMessages) {
    if (msg.role === 'tool' && (msg as unknown as Record<string, unknown>).tool_name === 'checkpoint' && msg.content) {
      checkpointResult = msg.content;
      break;
    }
  }

  const escAware = <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T): Promise<T> => {
    return ctx.core.escAware(fn, cleanup);
  };
  const lastQueryForRecap = turn.lastUserQuery || undefined;

  // ── Concurrent recap + patch via Promise.all ──
  // forkChat #1 (summary) and forkChat #2 (patch) fork from the same triologue
  // messages and run concurrently. See handleRecapWithPatch in checkpoint-recap.ts.
  const mindmap = ctx.core.getMindmap();
  const { summary, patch } = await handleRecapWithPatch(
    fullMessages,
    allTools,
    checkpoint.description,
    mindmap,
    checkpointId,
    escAware,
    comment,
    lastQueryForRecap,
    checkpointResult,
  );

  // Check for ESC cancellation
  if (summary.startsWith('[RECAP] Cancelled:')) {
    triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
    triologue.tool('recap', summary, call.id);
    ctx.core.brief('warn', 'recap', summary);
    // ESC pressed during recap - return to PROMPT immediately
    if (agentIO.isNeglectedMode()) {
      agentIO.setNeglectedMode(false);
      return AgentState.PROMPT;
    }
    turn.isFirstRound = false;
    return AgentState.COLLECT;
  }

  // Truncate at the assistant that called checkpoint — removes entire span.
  triologue.recapMessages(checkpoint.index);

  // Inject artificial assistant + tool result instead of note(),
  // so the triologue maintains natural tool-call flow.
  // The recap's own assistant message and tool result are persisted.
  // NOTE: handleRecap already assembles the full note in the correct order
  // (checkpoint-desc → recap-summary → last-user-query → recap-comment).
  // Do NOT append LUQ here — it is embedded inside the summary note.
  const noteContent = summary;

  triologue.agent('', [{
    id: call.id,
    function: {
      name: 'recap',
      arguments: call.function.arguments,
    },
  }]);
  triologue.tool('recap', noteContent, call.id);

  const tokensAfter = triologue.getTokenCount();
  ctx.core.brief('info', 'recap',
    `(${chalk.yellow(tokensBefore.toLocaleString())} → ${chalk.green(tokensAfter.toLocaleString())} tokens)`,
    `${checkpoint.description}${comment ? ` — ${comment}` : ''}`
  );

  // Close the auto-created checkpoint todo
  ctx.todo.closeCheckpointTodo(checkpointId);

  // ── Apply mindmap patch (if produced by forkChat #2) ──
  // Both the in-memory tree and the jsonl are updated simultaneously.
  // jsonl is the source of truth; in-memory is ephemeral (rebuilt from jsonl
  // at next startup). See docs/mindmap-redesign.md Part 2.6.
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
  pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx, hookExecutor } = env;

  try {
    // 1. Augment tool calls with metadata (file paths, LOC, destructive detection)
    const augmentedCalls = augmentToolCalls(pass.rawToolCalls);
    pass.augmentedCalls = augmentedCalls;

    // 2. Validate checkpoint isolation (must be called alone)
    const checkpointValidation = validateCheckpointIsolation(augmentedCalls);
    if (!checkpointValidation.valid) {
      // Register the error as tool responses so the LLM sees it and can retry
      triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
      for (const call of augmentedCalls) {
        triologue.tool(call.function.name, checkpointValidation.message!, call.id);
      }

      agentIO.log(chalk.yellow(`[checkpoint] blocked: ${checkpointValidation.message}`));
      return AgentState.COLLECT;
    }

    // 2b. Validate recap isolation (must be called alone)
    const recapValidation = validateRecapIsolation(augmentedCalls);
    if (!recapValidation.valid) {
      triologue.agent(pass.assistantContent, pass.rawToolCalls as ToolCall[] | undefined, pass.assistantReasoningContent);
      for (const call of augmentedCalls) {
        triologue.tool(call.function.name, recapValidation.message!, call.id);
      }

      agentIO.log(chalk.yellow(`[recap] blocked: ${recapValidation.message}`));
      return AgentState.COLLECT;
    }

    // 3. Process hooks (block/replace/inject/message) — moved before meta-tools
    //    so hooks can also fire on checkpoint/recap calls.
    const hookResult = await hookExecutor.processToolCalls(
      augmentedCalls,
      ctx,
      ctx.skill.getSkill.bind(ctx.skill),
    );
    pass.hookResult = hookResult;

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
      pass.deferredCompact = true;

      // Reset stat counts now — the confusion that triggered the compact is
      // stale regardless of when the compact itself runs.
      env.ctx.core.resetConfusionIndex();
      env.sequence.clear();
      env.crossroadOccurred = false;  // clear stale cooldown after compaction

      return AgentState.COLLECT;
    }

    // 4. Dispatch meta-tools (checkpoint and recap) from hook result
    //    Guard against blocked meta-calls so the agent sees the rejection.
    const checkpointCall = hookResult.calls.find(c => c.function.name === 'checkpoint');
    if (checkpointCall && !hookResult.blockedCalls.has(checkpointCall.id)) {
      return handleCheckpointCall(checkpointCall, env, pass, turn);
    }

    const recapCall = hookResult.calls.find(c => c.function.name === 'recap');
    if (recapCall && !hookResult.blockedCalls.has(recapCall.id)) {
      return handleRecapCall(recapCall, env, pass, turn);
    }

    // 5. Crossroad: FIRST-CLASS branch — handled BEFORE normal registration.
    //    Emits a SINGLE triologue.agent() call with merged content + brief tool call
    //    to engage the LLM actively. The brief gives a thinking trace to follow,
    //    nudging the LLM to regenerate tool calls for the continued direction.
    //    Stop-trigger hooks that fired on the empty rawToolCalls are intentionally
    //    not carried forward — crossroad's purpose is to have the LLM regenerate
    //    tool calls after resolving its direction.
    if (pass.crossroadContinuation) {
      // Join with a space: the continuation is the genuinely new content that
      // follows the prefix's last sentence (the anchor was stripped during
      // generation). A space reads as natural prose continuation, whereas a
      // newline would create a visual paragraph break mid-sentence.
      const finalContent = `${pass.assistantContent || ''} ${pass.crossroadContinuation}`;
      const briefCallId = Math.random().toString(36).slice(2, 10);
      triologue.agent(finalContent, [{
        id: briefCallId,
        function: {
          name: 'brief',
          arguments: { message: 'Resolved my direction. Let me continue with the tools.', confidence: 7 },
        },
      }] as ToolCall[], pass.assistantReasoningContent);
      triologue.tool('brief', 'OK', briefCallId);

      // Show only the continuation (the new direction) — the prefix is
      // already in pass.assistantContent and registered via triologue.agent()
      // above. Repeating it in the brief duplicates content the user saw.
      ctx.core.brief('info', 'crossroad', `Resolved: ${pass.crossroadContinuation}`);

      // Inject deferred hook messages so the LLM sees them in the next round.
      // Each deferred message carries its originating hook name for attribution.
      for (const dm of hookResult.deferredMessages) {
        triologue.note('REMINDER', dm.message, dm.hookName);
      }

      pass.crossroadContinuation = undefined;
      return AgentState.COLLECT;
    }

    // 6. Normal agent registration (no crossroad — mutual exclusion ensured
    //    by the early return above).
    const finalAssistantContent = pass.assistantContent;
    const finalToolCalls =
      hookResult.calls.length > 0
        ? hookResult.calls.map((c) => ({ id: c.id, function: c.function }))
        : undefined;
    triologue.agent(
      finalAssistantContent,
      finalToolCalls as ToolCall[] | undefined,
      pass.assistantReasoningContent,
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
          triologue.note('REMINDER', dm.message, dm.hookName);
        }
        return AgentState.COLLECT;
      }
      return AgentState.STOP;
    }

    if (pass.assistantContent) {
      ctx.core.brief('info', 'assistant', pass.assistantContent);
    }

    // From the second round onward, mute LLM text responses
    turn.isFirstRound = false;

    return AgentState.TOOL;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'hook', `HOOK state error: ${errorMessage}`);
    return AgentState.PROMPT;
  }
}