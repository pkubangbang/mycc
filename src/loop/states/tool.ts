/**
 * tool.ts - TOOL state handler
 *
 * Executes tool calls from the hook result sequentially.
 * Handles ESC interruption, hook blocking, sequence tracking,
 * ResultTooLargeError, confusion scoring, and deferred messages.
 */

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { ResultTooLargeError } from '../../types.js';
import { loader } from '../../context/shared/loader.js';
import { isVerbose } from '../../config.js';

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
  pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx, sequence } = env;
  const hookResult = pass.hookResult;
  if (!hookResult) return AgentState.COLLECT;

  // Execute each tool call sequentially
  for (const toolCall of hookResult.calls) {
    // ESC: abort current tool and return to PROMPT immediately
    if (agentIO.isNeglectedMode()) {
      agentIO.setNeglectedMode(false); // Clear neglected mode before returning to PROMPT
      // Skip any remaining pending tool calls to maintain triologue parity
      // (tool responses must follow assistant tool_calls)
      triologue.skipPendingTools(
        'Tool use interrupted - user pressed ESC.',
        'Tool use skipped due to ESC interruption.',
      );
      return AgentState.PROMPT;
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

      sequence.add({
        tool: toolName,
        args: toolCall.function.arguments as Record<string, unknown>,
        result: output,
        timestamp: Date.now(),
      });

      triologue.tool(toolName, output, toolCallId);

      // Track this tool call for semantic duplication detection
      await env.requestEmbeddingTracker.addEntry(toolName, toolCall.function.arguments as Record<string, unknown>);

      // Check for context overflow - if exceeded, abandon remaining tools and compact
      if (triologue.needsCompact()) {
        // Skip remaining pending tools with placeholder messages
        triologue.skipPendingTools(
          'Tool skipped due to context overflow - auto-compacting.',
          'Tool skipped due to context overflow.'
        );

        // Run compact immediately with focus on the current task
        await triologue.compact(turn.lastUserQuery || undefined);

        // Reset stat counts: confusion index and sequence events are stale
        // after compaction — the old context has been summarized away.
        ctx.core.resetConfusionIndex();
        env.requestEmbeddingTracker.clear();
        sequence.clear();

        // Return to COLLECT - agent will continue with fresh context
        return AgentState.COLLECT;
      }

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
      }

    } catch (err) {
      if (err instanceof ResultTooLargeError) {
        const truncatedOutput =
          `[Result too large: ${err.size} chars]\n` +
          `Full content saved to: ${err.filePath}\n` +
          `Use read tool to summarize, or bash with head/tail to read.\n\n` +
          `--- Preview (first 1000 chars) ---\n${err.preview}`;
        triologue.tool(toolName, truncatedOutput, toolCallId);

        // Check for context overflow after truncated result
        if (triologue.needsCompact()) {
          triologue.skipPendingTools(
            'Tool skipped due to context overflow - auto-compacting.',
            'Tool skipped due to context overflow.'
          );
          await triologue.compact(turn.lastUserQuery || undefined);

          // Reset stat counts after compaction
          ctx.core.resetConfusionIndex();
          env.requestEmbeddingTracker.clear();
          sequence.clear();

          return AgentState.COLLECT;
        }

        // Error increases confusion
        ctx.core.increaseConfusionIndex(2);
      } else {
        // Catch any other tool error, log as tool result, and continue
        // This prevents tool failures from killing the agent
        const errorMsg = err instanceof Error ? err.message : String(err);
        triologue.tool(toolName, `Error: ${errorMsg}`, toolCallId);
        agentIO.brief('error', 'tool', `${toolName} failed: ${errorMsg}`);
        ctx.core.increaseConfusionIndex(2);
        // Continue to next tool call in the loop
      }
    }
  }

  // Inject deferred hook messages after tool execution.
  // Each deferred message carries its originating hook name so the minifier
  // can emit ux[hookName]| and the hint round can attribute notes to hooks.
  for (const dm of hookResult.deferredMessages) {
    triologue.note('REMINDER', dm.message, dm.hookName);
  }

  return AgentState.COLLECT;
}
