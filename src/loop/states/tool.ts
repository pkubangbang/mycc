/**
 * tool.ts - TOOL state handler
 *
 * Executes tool calls from the hook result sequentially.
 * Handles ESC interruption, hook blocking, sequence tracking,
 * ResultTooLargeError, and deferred messages.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { ResultTooLargeError } from '../../types.js';
import { loader } from '../../context/shared/loader.js';
import { isVerbose } from '../../config.js';

export async function handleTool(
  env: MachineEnv,
  _turn: TurnVars,
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
      triologue.onToolResult(
        toolName,
        toolCall.function.arguments as Record<string, unknown>,
        output,
      );
    } catch (err) {
      if (err instanceof ResultTooLargeError) {
        const truncatedOutput =
          `[Result too large: ${err.size} chars]\n` +
          `Full content saved to: ${err.filePath}\n` +
          `Use read tool to summarize, or bash with head/tail to read.\n\n` +
          `--- Preview (first 1000 chars) ---\n${err.preview}`;
        triologue.tool(toolName, truncatedOutput, toolCallId);
        triologue.onToolResult(
          toolName,
          toolCall.function.arguments as Record<string, unknown>,
          truncatedOutput,
        );
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
