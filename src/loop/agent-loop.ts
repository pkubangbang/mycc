/**
 * agent-loop.ts - STAR-principle agent loop
 */

import chalk from 'chalk';
import * as fs from 'fs';
import { retryChat, MODEL } from '../ollama.js';
import type { AgentContext, ToolScope, ToolCall } from '../types.js';
import { ResultTooLargeError } from '../types.js';
import { buildSystemPrompt } from './agent-prompts.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { isVerbose } from '../config.js';
import { loader } from '../context/shared/loader.js';
import { Sequence } from '../context/shared/sequence.js';
import { ConditionRegistry } from '../context/shared/conditions.js';
import { HookExecutor, type AugmentedToolCall } from '../context/shared/hooks.js';

/**
 * Check if a bash command is destructive
 */
function isDestructiveCommand(command: string): boolean {
  const destructivePatterns = [
    /rm\s+-rf/,
    /rm\s+-r/,
    /git\s+push\s+--force/,
    /git\s+push\s+-f\s+/,
    /git\s+reset\s+--hard/,
    /drop\s+database/i,
    /truncate\s+table/i,
    /delete\s+from/i,
    /\bsudo\s+rm\b/,
    />\s*\/dev\/(sda|hda|nvme)/,
  ];
  return destructivePatterns.some(p => p.test(command));
}

/**
 * Augment a single tool call with metadata
 */
function augmentCall(call: ToolCall, _ctx: AgentContext): AugmentedToolCall {
  const args = call.function.arguments as Record<string, unknown>;
  const metadata: AugmentedToolCall['metadata'] = {};

  switch (call.function.name) {
    case 'write_file':
    case 'edit_file': {
      metadata.filePath = args.file_path as string;
      metadata.isTestFile = metadata.filePath?.includes('.test.') || metadata.filePath?.includes('.spec.');
      if (args.content && typeof args.content === 'string') {
        metadata.newLoc = args.content.split('\n').length;
      }
      // Check existing file LOC
      if (metadata.filePath && fs.existsSync(metadata.filePath)) {
        try {
          const existing = fs.readFileSync(metadata.filePath, 'utf-8');
          metadata.existingLoc = existing.split('\n').length;
        } catch {
          // Ignore read errors
        }
      }
      break;
    }

    case 'bash': {
      if (args.command && typeof args.command === 'string') {
        metadata.isDestructive = isDestructiveCommand(args.command);
      }
      break;
    }
  }

  return { ...call, metadata };
}

/**
 * Augment an array of tool calls with metadata for hook evaluation
 */
async function augmentToolCalls(
  calls: ToolCall[],
  ctx: AgentContext
): Promise<AugmentedToolCall[]> {
  return calls.map(call => augmentCall(call, ctx));
}

/**
 * Custom error for graceful shutdown
 */
export class ShutdownError extends Error {
  constructor(message: string = 'Agent shutting down') {
    super(message);
    this.name = 'ShutdownError';
  }
}

/**
 * Agent loop - STAR principle: Situation, Task, Action, Result
 * @throws ShutdownError when agent is shutting down
 */
export async function agentLoop(
  triologue: Triologue,
  ctx: AgentContext,
  scope: ToolScope = 'main'
): Promise<void> {
  let nextTodoNudge = 3;
  let lastTodoState = '';
  let isFirstRound = true;

  // Initialize hook system
  const conditions = new ConditionRegistry();
  await conditions.load();
  const sequence = new Sequence(triologue);  // Pass triologue for sequence queries
  const hookExecutor = new HookExecutor(conditions, sequence);

  while (true) {
    try {
      // 1. Handle pending questions from children
      await ctx.team.handlePendingQuestions();

      // 2. Collect mails (collated into single user message)
      // When in neglected mode, add urgency to wrap up quickly
      const mails = ctx.mail.collectMails();
      if (mails.length > 0) {
        const mailContent = mails
          .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
          .join('\n\n---\n\n');

        if (agentIO.isNeglectedMode()) {
          triologue.user(`[URGENT: user interrupted - wrap up quickly]\n${mailContent}`);
        } else {
          triologue.user(mailContent);
        }
      }

      // 2.5 Generate hint round if threshold reached
      if (triologue.needsHintRound()) {
        agentIO.log(chalk.blue('[hint round] Generating problem analysis...'));
        await triologue.generateHintRound();
      }

      // 3. Todo nudging with state tracking to reset counter on todo changes
      if (ctx.todo.hasOpenTodo()) {
        const currentTodoState = ctx.todo.printTodoList();
        if (currentTodoState !== lastTodoState) {
          nextTodoNudge = 3; // Reset counter when todos change
          lastTodoState = currentTodoState;
        }
        nextTodoNudge--;
        if (nextTodoNudge === 0) {
          triologue.user(`<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`);
          nextTodoNudge = 3;
        }
      }

      // 4. Build system prompt and call LLM
      // Ensure we have a valid message sequence before calling LLM
      const lastRole = triologue.getLastRole();
      if (lastRole === 'assistant') {
        // Last message was assistant with no tool calls - need user message before next LLM call
        // This can happen after awaitTeam() returns without new input
        triologue.user('Continue with your task.');
      }

      const systemPrompt = buildSystemPrompt(ctx);
      triologue.setSystemPrompt(systemPrompt);

      // Verbose: Log system prompt
      if (isVerbose()) {
        agentIO.log(chalk.magenta('[verbose][agent-loop] System prompt:'));
        agentIO.log(chalk.gray(systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? '...' : '')));
      }

      // Create abort controller for this LLM call (allows Ctrl+C to interrupt)
      const abortController = agentIO.createLlmAbortController();

      // In interrupted mode, provide no tools so LLM can only respond with text
      const tools = agentIO.isNeglectedMode() ? [] : loader.getToolsForScope(scope);

      try {
        const response = await retryChat(
          {
            model: MODEL,
            messages: triologue.getMessages(),
            tools,
            // enable thinking when ESC is hit (wrapping up), to guess the user's intention.
            think: agentIO.isNeglectedMode(),
          },
          { signal: abortController.signal, neglected: agentIO.isNeglectedMode() }
        );

        // Clear abort controller after successful call
        agentIO.clearLlmAbortController();

        // Check if ESC was pressed DURING this LLM call - discard response if so
        // Only discard if the abort signal was triggered for THIS call
        if (abortController.signal.aborted) {
          agentIO.log(chalk.yellow('[ESC] LLM response discarded due to interruption'));
          // Inject message about LLM interruption for wrap-up
          triologue.user('LLM call interrupted. Please wrap up and ask user for next steps.');
          continue;
        }

        // 5. Handle response
        const assistantMessage = response.message;
        triologue.agent(assistantMessage.content || '', assistantMessage.tool_calls as ToolCall[] | undefined);

        // 6. No tool calls = wrap-up complete or check team status
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          // 6.1 Check stop hooks (LLM is about to stop)
          const stopResult = await hookExecutor.processToolCalls(
            [],  // Empty array - no pending calls
            ctx,
            ctx.skill.getSkill.bind(ctx.skill)
          );

          if (stopResult.calls.length > 0) {
            // Register and execute injected calls
            for (const call of stopResult.calls) {
              triologue.registerToolCall(call);
            }

            for (const toolCall of stopResult.calls) {
              const toolName = toolCall.function.name;
              try {
                const output = await loader.execute(toolName, ctx, toolCall.function.arguments as Record<string, unknown>);

                // Add to sequence for hook evaluation
                sequence.add({
                  tool: toolName,
                  args: toolCall.function.arguments as Record<string, unknown>,
                  result: output,
                  timestamp: Date.now(),
                });

                triologue.tool(toolName, output, toolCall.id);
                triologue.onToolResult(toolName, toolCall.function.arguments as Record<string, unknown>, output);

                if (isVerbose()) {
                  agentIO.log(chalk.cyan(`[hook] stop hook executed ${toolName}: ${output.slice(0, 100)}...`));
                }
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                triologue.tool(toolName, `Error: ${errorMsg}`, toolCall.id);
                agentIO.log(chalk.red(`[hook] stop hook failed to execute ${toolName}: ${errorMsg}`));
              }
            }

            // Inject deferred messages
            if (stopResult.deferredMessages.length > 0) {
              triologue.user(stopResult.deferredMessages.join('\n\n---\n\n'));
            }

            continue;  // Let LLM summarize
          }

          // Inject deferred messages from non-blocking hooks
          if (stopResult.deferredMessages.length > 0) {
            triologue.user(stopResult.deferredMessages.join('\n\n---\n\n'));
          }

          // Clear interrupted mode after wrap-up response (no tools = wrap-up complete)
          if (agentIO.isNeglectedMode()) {
            agentIO.setNeglectedMode(false);  // Clear FIRST - so isInteractionMode() returns false

            // Notify user if teammates still working
            const teammates = ctx.team.listTeammates();
            if (teammates.some(t => t.status === 'working')) {
              agentIO.log(chalk.yellow('teammates still working (use /team to check status)'));
            }

            // Flush buffered output (after clearing neglected mode)
            agentIO.flushOutput();

            return;
          }

          const { result } = await ctx.team.awaitTeam(30000);

          // Handle awaitTeam result
          if (result === 'got question' || ctx.mail.hasNewMails()) {
            // Teammate has question or new mail - continue to next iteration
            continue;
          } else if (result === 'all done' || result === 'no workload' || result === 'no teammates') {
            // All finished or no work - we're done
            return;
          } else if (result === 'timeout') {
            // Timeout - inject status message and retry
            triologue.user(`Timeout waiting for teammates. Use tm_await to wait longer, or check team status with /team. ${ctx.team.printTeam()}`);
            continue;
          } else {
            // Unsupported result type - warn and continue
            ctx.core.brief('warn', 'awaitTeam', `Unexpected result: ${result}`);
            continue;
          }
        } else if (isFirstRound && assistantMessage.content) {
          // 6.1 has tool call + is first round + has content = brief this response
          ctx.core.brief('info', 'assistant', assistantMessage.content);
        }

        // from the second round, mute all LLM's responses.
        isFirstRound = false;

        // 7. Augment tool calls with metadata
        const rawToolCalls = [...(assistantMessage.tool_calls as ToolCall[])];
        const augmentedCalls = await augmentToolCalls(rawToolCalls, ctx);

        // 8. Process hooks against augmented tool call array
        const hookResult = await hookExecutor.processToolCalls(
          augmentedCalls,
          ctx,
          ctx.skill.getSkill.bind(ctx.skill)
        );

        // Register injected calls for triologue parity
        for (const call of hookResult.calls) {
          if (call.id.startsWith('hook-')) {
            triologue.registerToolCall(call);
          }
        }

        // 9. Execute each tool call (blocked calls return rejection message)
        let deferredMessagesInjected = false;
        for (const toolCall of hookResult.calls) {
          // Check for ESC - abort current tool and skip remaining
          if (agentIO.isNeglectedMode()) {
            agentIO.log(chalk.yellow('\n[ESC] Tool execution interrupted - skipping remaining tools'));
            triologue.skipPendingTools(
              'Tool use interrupted - user pressed ESC.',
              'Tool use skipped due to ESC interruption.'
            );
            triologue.user('The user pressed ESC to interrupt. Please wrap up and wait for next instruction.');
            break;
          }

          const toolCallId = toolCall.id;
          const toolName = toolCall.function.name;

          // Check if this call was blocked by a hook
          if (hookResult.blockedCalls.has(toolCallId)) {
            triologue.tool(toolName, hookResult.blockedCalls.get(toolCallId)!, toolCallId);
            agentIO.log(chalk.yellow(`[hook] blocked ${toolName}: ${hookResult.blockedCalls.get(toolCallId)}`));
            continue;
          }

          // Verbose: Log tool execution
          if (isVerbose()) {
            agentIO.log(chalk.magenta(`[verbose][agent-loop] Executing tool: ${toolName}`));
            const argsPreview = JSON.stringify(toolCall.function.arguments).slice(0, 200);
            agentIO.log(chalk.gray(`  Args: ${argsPreview}${argsPreview.length >= 200 ? '...' : ''}`));
          }

          try {
            const output = await loader.execute(toolName, ctx, toolCall.function.arguments as Record<string, unknown>);

            // Verbose: Log tool result
            if (isVerbose()) {
              agentIO.log(chalk.magenta(`[verbose][agent-loop] Tool result: ${toolName}`));
              agentIO.log(chalk.gray(`  Output length: ${output.length} chars`));
              const outputPreview = output.slice(0, 300);
              agentIO.log(chalk.gray(`  Preview: ${outputPreview}${output.length > 300 ? '...' : ''}`));
            }

            // Add to sequence for hook evaluation
            sequence.add({
              tool: toolName,
              args: toolCall.function.arguments as Record<string, unknown>,
              result: output,
              timestamp: Date.now(),
            });

            triologue.tool(toolName, output, toolCallId);
            triologue.onToolResult(toolName, toolCall.function.arguments as Record<string, unknown>, output);

            // Inject deferred messages after first tool result (only once)
            if (!deferredMessagesInjected && hookResult.deferredMessages.length > 0) {
              triologue.user(hookResult.deferredMessages.join('\n\n---\n\n'));
              deferredMessagesInjected = true;
            }
          } catch (err) {
            if (err instanceof ResultTooLargeError) {
              const truncatedOutput = `[Result too large: ${err.size} chars]\n` +
                `Full content saved to: ${err.filePath}\n` +
                `Use read_read tool to summarize, or bash with head/tail to read.\n\n` +
                `--- Preview (first 1000 chars) ---\n${err.preview}`;

              triologue.tool(toolName, truncatedOutput, toolCallId);
              triologue.onToolResult(toolName, toolCall.function.arguments as Record<string, unknown>, truncatedOutput);

              if (!deferredMessagesInjected && hookResult.deferredMessages.length > 0) {
                triologue.user(hookResult.deferredMessages.join('\n\n---\n\n'));
                deferredMessagesInjected = true;
              }
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        // Always clear abort controller
        agentIO.clearLlmAbortController();

        // Check if this was an abort during LLM call
        if (err instanceof Error && err.message === 'Request aborted') {
          agentIO.log(chalk.yellow('[ESC] LLM call interrupted'));
          // Inject message for wrap-up instead of throwing ShutdownError
          triologue.user('LLM call interrupted. Please wrap up and ask user for next steps.');
          continue;
        }

        throw err;
      }
    } catch (err) {
      // Check if we should exit (shutdown)
      if (err instanceof ShutdownError) {
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Teammate timeout - give LLM context and options to decide
      if (err instanceof Error && errorMessage.includes('Timeout waiting for teammate')) {
        agentIO.warn(chalk.yellow(`[agent-loop] Recoverable error: ${errorMessage}`));
        triologue.user(`Timeout waiting for teammates. What will you do? ${ctx.team.printTeam()}\n\nOptions:\n- Wait longer (use tm_await with higher timeout)\n- Remove teammate (use tm_remove)\n- Continue without waiting (just proceed with other tasks)`);
        continue;
      }

      // All errors should bubble up to main() which prompts user for retry
      // Only teammate timeout is handled locally (LLM decides what to do)
      throw err;
    }
  }
}
