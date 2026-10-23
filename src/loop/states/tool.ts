/**
 * tool.ts - TOOL state handler
 *
 * Executes tool calls from the hook result sequentially.
 * Handles ESC interruption, hook blocking, sequence tracking,
 * ResultTooLargeError, confusion scoring, and deferred messages.
 */

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { ResultTooLargeError } from '../../types.js';
import { loader } from '../../context/shared/loader.js';
import { isVerbose } from '../../config.js';
import { loopEvents } from '../loop-events.js';
import { BRIEF_OK, briefReceiptLine, hashOf, stampBriefResult } from '../triologue/recap-note.js';

/**
 * A CHILD-scope brief result: the same `OK` ack the handler returns, prefixed
 * with the anchor hash but WITHOUT the `recap(target=…)` invitation — `recap` is
 * lead-only, so the call shape would name a tool the teammate does not have.
 *
 * Today a teammate's loop (context/teammate-worker.ts) registers its results
 * directly and never reaches this stage, so this branch is a guard, not a
 * behaviour: it keeps the lead-only invitation from leaking IF that path ever
 * starts routing through handleTool. Cheap, and the alternative — a stamp whose
 * audience rule lives only in a caller's address space — is exactly the bug this
 * branch exists to prevent.
 *
 * Same rules as `stampBriefResult`: idempotent, and a no-op on anything that is
 * not a pristine success or that has no call id.
 */
function childBriefReceipt(content: string, callId: string | undefined): string {
  if (hashOf(content) !== null) return content;
  if (!content.startsWith(BRIEF_OK)) return content;
  if (!callId) return content;
  const rest = content.slice(BRIEF_OK.length).replace(/^\.\s*/, '').trim();
  const line = briefReceiptLine(callId);
  return rest ? `${line}\n${rest}` : line;
}

// Tools that are purely exploratory (information gathering)
const EXPLORATION_TOOLS = new Set([
  'read_file',
  'web_search',
  'web_fetch',
  'brief',
  'issue_list',
  'bg_print',
  'tm_print',
  'question',
  'recall',
]);

/**
 * Check if a tool result indicates an error
 */
function isErrorResult(result: string): boolean {
  if (!result) return false;
  const lower = result.toLowerCase();
  // Common error prefixes
  if (lower.startsWith('error:') || lower.startsWith('error ') || lower.startsWith('fatal:')) return true;
  // Shell exit codes
  if (/command failed with exit code \d+/.test(lower)) return true;
  // Node.js error patterns
  if (lower.includes('eacces') || lower.includes('enoent') || lower.includes('eperm')) return true;
  // Permission denied
  if (lower.includes('permission denied')) return true;
  // Not found / does not exist
  if (lower.includes('not found') || lower.includes('does not exist') || lower.includes('no such file')) return true;
  return false;
}

export async function handleTool(
  env: MachineEnv,
  turn: TurnVars,
  chat: ChatData,
): Promise<HandlerResult> {
  const { triologue, ctx, sequence } = env;
  const hookResult = chat.hookResult;
  if (!hookResult) return AgentState.COLLECT;

  // Execute each tool call sequentially
  for (const toolCall of hookResult.calls) {
    // ESC: abort current tool and return to STOP for centralized wrap-up
    if (agentIO.isNeglectedMode()) {
      // Observability: emit esc_interrupt (silent when no listeners)
      loopEvents.emit('esc_interrupt', { state: 'tool' });
      // Skip any remaining pending tool calls to maintain triologue parity
      // (tool responses must follow assistant tool_calls)
      triologue.skipPendingTools(
        'Tool use interrupted - user pressed ESC.',
        'Tool use skipped due to ESC interruption.',
      );
      // Return STOP for centralized wrap-up (stop.ts handles startWrapUp +
      // auto-off + setNeglectedMode). Neglected mode is NOT cleared here.
      return AgentState.STOP;
    }

    const toolCallId = toolCall.id;
    const toolName = toolCall.function.name;

    // Hook-blocked call: register rejection, continue to next
    if (hookResult.blockedCalls.has(toolCallId)) {
      triologue.tool(toolName, hookResult.blockedCalls.get(toolCallId)!, toolCallId);
      agentIO.verbose('hook', `blocked ${toolName}: ${hookResult.blockedCalls.get(toolCallId)}`);
      continue;
    }

    if (isVerbose()) {
      agentIO.verbose('tool', `Executing: ${toolName}`);
      agentIO.verbose('tool', `Args: ${JSON.stringify(toolCall.function.arguments).slice(0, 200)}`);
    }

    try {
      // Use escAware for ESC-interruptible tool execution
      const output = await ctx.core.escAware(
        async (abortController) => {
          return await loader.execute(
            toolName,
            ctx,
            toolCall.function.arguments as Record<string, unknown>,
            abortController.signal,
          );
        },
        () => 'Tool interrupted by user.'
      );

      if (isVerbose()) {
        agentIO.verbose('tool', `Result: ${toolName}`, { outputLength: output.length });
      }

      // A brief's success result is turned into the ANCHOR LINE — the fixed
      // first line `[<hash>] ANCHOR — recap(target="<hash>") to fold everything
      // above`, plus the "open" candidate list — here, and only here: the
      // handler receives no call id, and only the loop can see the brief stack
      // the candidates come from. The hash is `briefHash(callId)`, the same
      // token recap writes back (`noteWithSummary`) and `recap(target=…)`
      // resolves, so a brief is addressable the moment it lands. Only the
      // pristine "OK…" result is stamped: an error is never relabelled as an
      // anchor. See recap-note.ts stampBriefResult.
      //
      // TEAMMATES GET A RECEIPT, NOT THE ANCHOR LINE: `brief` is shared with the
      // child scope while `recap` is lead-only (src/tools/brief.ts), so printing
      // a `recap(target=…)` call to a teammate advertises a tool it cannot call.
      // The hash still prefixes the line — nothing else about the result changes.
      // (Guards a path the teammate worker does not currently take; see
      // childBriefReceipt.)
      const resultContent = toolName === 'brief'
        ? (env.scope === 'main'
            ? stampBriefResult(output, toolCallId, triologue.listOpenAnchors())
            : childBriefReceipt(output, toolCallId))
        : output;

      // Observability: emit tool_executed (silent when no listeners)
      loopEvents.emit('tool_executed', { tool: toolName, outputLength: output.length });

      sequence.add({
        tool: toolName,
        args: toolCall.function.arguments as Record<string, unknown>,
        result: resultContent,
        timestamp: Date.now(),
      });

      triologue.tool(toolName, resultContent, toolCallId);

      // Track this tool call for semantic duplication detection
      await env.requestEmbeddingTracker.addEntry(toolName, toolCall.function.arguments as Record<string, unknown>);

      // NOTE: Context-overflow auto-compact no longer runs here. It has been
      // relocated to the top of the LLM stage (llm.ts), where
      // loader.getToolsForScope(scope) is in scope and triologue.getMessages()
      // is the exact cache prefix the next LLM call will use — so the forkChat
      // inside compact() is a guaranteed cache hit. If a tool result pushes us
      // over the threshold here, the next LLM stage entry catches it (at most
      // one extra tool result over threshold, which is harmless: the model's
      // context window is larger than TOKEN_THRESHOLD).

      // Semantic duplication detection via embedding similarity.
      // Replaces the old "same tool name in last 5 calls" heuristic.
      // Exploration tools don't affect confusion.
      if (!EXPLORATION_TOOLS.has(toolName)) {
        const maxSim = env.requestEmbeddingTracker.getMaxSimilarity();
        const delta = env.requestEmbeddingTracker.similarityToDelta(maxSim);
        if (delta > 0) {
          ctx.core.increaseConfusionIndex(delta);
        } else {
          // No semantic duplication — progress is being made
          ctx.core.increaseConfusionIndex(-1);
        }
      }

      // Check for error results
      if (isErrorResult(output)) {
        ctx.core.increaseConfusionIndex(2);
      }

      // Reset brief nudge only when brief tool is used
      if (toolName === 'brief') {
        turn.nextBriefNudge = 5;

        // Store the brief message for the COLLECT skill-discovery composite
        // (X source). Keyword extraction itself has moved to COLLECT, which
        // composes X (this brief) + Y (user query / steering note) + Z
        // (hint round focus_on). See docs/misc/plan-composite-keyword-extraction.md.
        try {
          const briefArgs = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments as Record<string, unknown>;
          const briefMessage = briefArgs?.message as string;
          if (briefMessage && typeof briefMessage === 'string') {
            turn.lastBriefMessage = briefMessage;
          }
        } catch {
          // Swallow — brief message capture is best-effort.
        }
      }

    } catch (err) {
      if (err instanceof ResultTooLargeError) {
        const truncatedOutput =
          `[Result too large: ${err.size} chars]\n` +
          `Full content saved to: ${err.filePath}\n` +
          `Use read tool to summarize, or bash with head/tail to read.\n\n` +
          `--- Preview (first 1000 chars) ---\n${err.preview}`;
        triologue.tool(toolName, truncatedOutput, toolCallId);

        // Observability: emit tool_error (silent when no listeners)
        loopEvents.emit('tool_error', { tool: toolName, error: err.message, kind: 'result_too_large' });

        // NOTE: Context-overflow auto-compact no longer runs here (relocated
        // to the LLM stage — see the note above). The next LLM stage entry
        // will catch any threshold breach.

        // Error increases confusion
        ctx.core.increaseConfusionIndex(2);
      } else {
        // Catch any other tool error, log as tool result, and continue
        // This prevents tool failures from killing the agent
        const errorMsg = err instanceof Error ? err.message : String(err);
        triologue.tool(toolName, `Error: ${errorMsg}`, toolCallId);
        agentIO.brief('error', 'tool', `${toolName} failed: ${errorMsg}`);

        // Observability: emit tool_error (silent when no listeners)
        loopEvents.emit('tool_error', { tool: toolName, error: errorMsg, kind: 'generic' });

        ctx.core.increaseConfusionIndex(2);
        // Continue to next tool call in the loop
      }
    }
  }

  // Inject deferred hook messages after tool execution.
  // Each deferred message carries its originating hook name so the minifier
  // can emit ux[hookName]| and the hint round can attribute notes to hooks.
  for (const dm of hookResult.deferredMessages) {
    triologue.note('REMINDER', dm.hookName ? `Hook "${dm.hookName}" deferred this message: ${dm.message}` : dm.message, dm.hookName);
  }

  return AgentState.COLLECT;
}
