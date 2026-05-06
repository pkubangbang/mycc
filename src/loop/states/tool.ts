/**
 * tool.ts - TOOL state handler
 *
 * Executes tool calls from the hook result sequentially.
 * Handles ESC interruption, hook blocking, sequence tracking,
 * ResultTooLargeError, confusion scoring, and deferred messages.
 */

import chalk from 'chalk';
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
  'wt_print',
  'bg_print',
  'tm_print',
  'question',
  'recall',
]);

// Tools that modify state (progress indicators)
const ACTION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'todo_write',
  'issue_create',
  'issue_close',
  'issue_claim',
  'issue_comment',
  'blockage_create',
  'blockage_remove',
  'tm_create',
  'tm_remove',
  'wt_create',
  'wt_remove',
  'bg_create',
  'bg_remove',
  'mail_to',
  'broadcast',
  'git_commit',
]);

// Read-only bash commands (exploration)
const READ_ONLY_BASH = /^(ls|cat|pwd|head|tail|wc|find|which|git\s+(status|log|diff|branch|show|ls-files))/;

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
      agentIO.log(chalk.yellow('\n[ESC] Tool execution interrupted - returning to prompt'));
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
      agentIO.log(chalk.yellow(`[hook] blocked ${toolName}: ${hookResult.blockedCalls.get(toolCallId)}`));
      continue;
    }

    if (isVerbose()) {
      agentIO.log(chalk.magenta(`[verbose][tool] Executing: ${toolName}`));
      const argsPreview = JSON.stringify(toolCall.function.arguments).slice(0, 200);
      agentIO.log(chalk.gray(`  Args: ${argsPreview}${argsPreview.length >= 200 ? '...' : ''}`));
    }

    try {
      const output = await loader.execute(
        toolName,
        ctx,
        toolCall.function.arguments as Record<string, unknown>,
      );

      if (isVerbose()) {
        agentIO.log(chalk.magenta(`[verbose][tool] Result: ${toolName}`));
        agentIO.log(chalk.gray(`  Output length: ${output.length} chars`));
      }

      sequence.add({
        tool: toolName,
        args: toolCall.function.arguments as Record<string, unknown>,
        result: output,
        timestamp: Date.now(),
      });

      triologue.tool(toolName, output, toolCallId);

      // Confusion scoring based on tool classification
      // Exploration tools: no change to confusion
      // Action tools: reduce confusion (progress being made)
      // Error results: increase confusion
      if (!EXPLORATION_TOOLS.has(toolName)) {
        if (toolName === 'bash') {
          const cmd = String(toolCall.function.arguments?.command || '');
          if (!READ_ONLY_BASH.test(cmd)) {
            // Action bash command reduces confusion
            ctx.core.increaseConfusionIndex(-1);
          }
          // Read-only bash: no change to confusion
        } else if (ACTION_TOOLS.has(toolName)) {
          // Action tool reduces confusion
          ctx.core.increaseConfusionIndex(-1);
        }
      }

      // Check for error results
      if (isErrorResult(output)) {
        ctx.core.increaseConfusionIndex(2);
      }

      // Reset brief nudge on successful tool execution
      turn.nextBriefNudge = 5;

    } catch (err) {
      if (err instanceof ResultTooLargeError) {
        const truncatedOutput =
          `[Result too large: ${err.size} chars]\n` +
          `Full content saved to: ${err.filePath}\n` +
          `Use read tool to summarize, or bash with head/tail to read.\n\n` +
          `--- Preview (first 1000 chars) ---\n${err.preview}`;
        triologue.tool(toolName, truncatedOutput, toolCallId);
        
        // Error increases confusion
        ctx.core.increaseConfusionIndex(2);
      } else {
        throw err;
      }
    }
  }

  // Inject deferred hook messages after tool execution
  if (hookResult.deferredMessages.length > 0) {
    triologue.user(hookResult.deferredMessages.join('\n\n---\n\n'));
  }

  return AgentState.COLLECT;
}
