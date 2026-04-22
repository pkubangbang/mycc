/**
 * agent-loop.ts - STAR-principle agent loop
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { retryChat, MODEL, OLLAMA_HOST, checkHealth, classifyError } from '../ollama.js';
import type { AgentContext, ToolScope, ToolCall, SlashCommandContext } from '../types.js';
import { ResultTooLargeError } from '../types.js';
import { ParentContext } from '../context/index.js';
import { readSession, writeSession, getSessionId } from '../session/index.js';
import { slashRegistry } from '../slashes/index.js';
import { buildSystemPrompt } from './agent-prompts.js';
import { getTokenThreshold } from '../config.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { isVerbose, shouldSkipHealthCheck } from '../config.js';
import { openMultilineEditor } from '../utils/multiline-input.js';
import { displayLetterBox } from '../utils/letter-box.js';
import { createRequire } from 'module';
import { loader } from '../context/loader.js';
import { buildSkillHint, initializeSession, SessionInit } from './agent-loop-helper.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

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
        }

        // 7. Execute tools
        for (const toolCall of (assistantMessage.tool_calls as ToolCall[])) {
          // Check for ESC - abort current tool and skip remaining
          if (agentIO.isNeglectedMode()) {
            agentIO.log(chalk.yellow('\n[ESC] Tool execution interrupted - skipping remaining tools'));
            // First tool gets "interrupted", remaining get "skipped"
            triologue.skipPendingTools(
              'Tool use interrupted - user pressed ESC.',
              'Tool use skipped due to ESC interruption.'
            );
            // Inject user message and let LLM wrap up
            triologue.user('The user pressed ESC to interrupt. Please wrap up and wait for next instruction.');
            break;  // Exit tool loop, continue to next LLM call for wrap-up
          }

          const toolCallId = toolCall.id;
          const args = toolCall.function.arguments as Record<string, unknown>;
          const toolName = toolCall.function.name;

          // Verbose: Log tool execution
          if (isVerbose()) {
            agentIO.log(chalk.magenta(`[verbose][agent-loop] Executing tool: ${toolName}`));
            const argsPreview = JSON.stringify(args).slice(0, 200);
            agentIO.log(chalk.gray(`  Args: ${argsPreview}${argsPreview.length >= 200 ? '...' : ''}`));
          }

          try {
            const output = await loader.execute(toolName, ctx, args);

            // Verbose: Log tool result
            if (isVerbose()) {
              agentIO.log(chalk.magenta(`[verbose][agent-loop] Tool result: ${toolName}`));
              agentIO.log(chalk.gray(`  Output length: ${output.length} chars`));
              const outputPreview = output.slice(0, 300);
              agentIO.log(chalk.gray(`  Preview: ${outputPreview}${output.length > 300 ? '...' : ''}`));
            }

            triologue.tool(toolName, output, toolCallId);
            triologue.onToolResult(toolName, args, output);
          } catch (err) {
            if (err instanceof ResultTooLargeError) {
              // Handle large result: use preview + instruction
              const truncatedOutput = `[Result too large: ${err.size} chars]\n` +
                `Full content saved to: ${err.filePath}\n` +
                `Use read_read tool to summarize, or bash with head/tail to read.\n\n` +
                `--- Preview (first 1000 chars) ---\n${err.preview}`;

              triologue.tool(toolName, truncatedOutput, toolCallId);
              triologue.onToolResult(toolName, args, truncatedOutput);
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

      // Classify error for appropriate handling
      const errorType = classifyError(err);

      // All errors should bubble up to main() which prompts user for retry
      // Only teammate timeout is handled locally (LLM decides what to do)
      throw err;
    }
  }
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  // Guard: Must run under Coordinator
  if (!process.send) {
    console.error(chalk.red('Error: Lead process must be started via Coordinator (mycc command)'));
    console.error(chalk.gray('Run: mycc'));
    process.exit(1);
  }

  // Force colors since stdout is piped through Coordinator (not a TTY)
  chalk.level = 1;

  // Get token threshold once (env value, doesn't change during execution)
  const tokenThreshold = getTokenThreshold();

  // Initialize AgentIO early (needed for ask() during health check and session restoration)
  agentIO.initMain();

  // Health check: validate Ollama connectivity and model availability
  // Skip if --skip-healthcheck flag is set (useful for testing)
  let modelInfo: { family?: string; parameterSize?: string; contextLength: number } | null = null;
  if (shouldSkipHealthCheck()) {
    console.log(chalk.gray('Skipping health check (test mode)'));
  } else {
    // Retry loop for health check - only exit on user request or Ctrl+C
    while (true) {
      const health = await checkHealth(tokenThreshold);
      if (health.ok) {
        if (health.modelInfo) {
          modelInfo = health.modelInfo;
        }
        break; // Success - continue with startup
      }

      // Health check failed - show error and prompt for retry
      console.error(chalk.red(`Health check failed: ${health.error}`));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(chalk.yellow('Common fixes:'));
      console.log(chalk.gray('  1. Ensure Ollama is running: ollama serve'));
      console.log(chalk.gray('  2. Check OLLAMA_HOST in ~/.mycc-store/.env'));
      console.log(chalk.gray('  3. Verify model exists: ollama list'));
      console.log();

      const answer = await agentIO.ask(chalk.cyan('Retry health check? [Y/n] > '));

      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        process.exit(1);
      }

      console.log(chalk.cyan('Retrying health check...'));
      console.log();
    }
  }

  // Display startup info with aligned labels
  const labelWidth = 12; // Width for label alignment
  const alignLabel = (label: string) => label.padEnd(labelWidth);

  console.log();
  console.log(chalk.cyan.bold(`Coding Agent v${version}`));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.cyan(`${alignLabel('Model:')}${MODEL}`));
  console.log(chalk.gray(`${alignLabel('Host:')}${OLLAMA_HOST}`));

  if (modelInfo) {
    if (modelInfo.family) {
      console.log(chalk.gray(`${alignLabel('Family:')}${modelInfo.family}`));
    }
    if (modelInfo.parameterSize) {
      console.log(chalk.gray(`${alignLabel('Params:')}${modelInfo.parameterSize}`));
    }
    console.log(chalk.gray(`${alignLabel('Context:')}${modelInfo.contextLength}`));
  }

  console.log(chalk.gray(`${alignLabel('Threshold:')}${tokenThreshold} tokens`));

  // Initialize session (restore or create new)
  const sessionInit = await initializeSession();
  const { sessionFilePath, triologuePath, restoredPair } = sessionInit;
  let initialQuery = sessionInit.initialQuery; // Mutable for clearing after first use

  // Display session info (after initialization so we have the session ID)
  const sessionId = getSessionId(sessionFilePath);
  console.log(chalk.gray(`${alignLabel('Session:')}${sessionId.slice(0, 7)}`));

  const commands = slashRegistry.list().map(c => `/${c}`).join(', ');
  console.log(chalk.gray(`${alignLabel('Commands:')}${commands}, /exit`));
  console.log();

  // Track first query for bookmark title
  let firstQueryCaptured = false;

  // Load tools/skills using singleton loader
  await loader.loadAll();
  loader.watchDirectories();

  // Create context with loader
  const ctx = new ParentContext(loader, sessionFilePath);
  ctx.initializeIpcHandlers();

  // Check if skills domain exists (warn if not)
  await ctx.wiki.checkSkillsDomain();

  // Sync worktrees with git (reconcile any orphaned worktrees from previous sessions)
  await ctx.wt.syncWorkTrees();

  const triologue = new Triologue({
    tokenThreshold,
    wiki: ctx.wiki,
    onMessage: (messages) => {
      const lastMsg = messages[messages.length - 1];
      try {
        fs.appendFileSync(triologuePath, JSON.stringify(lastMsg) + '\n', 'utf-8');
      } catch {
        // Ignore write errors
      }
    },
  });

  // If restored session, load the summary pair
  if (restoredPair !== null) {
    triologue.loadRestoration(restoredPair);
  }

  // Inject project context files (best-effort: skip if not found)
  const claudePath = path.join(process.cwd(), 'CLAUDE.md');
  const readmePath = path.join(process.cwd(), 'README.md');

  if (fs.existsSync(claudePath)) {
    triologue.setClaudeMd(fs.readFileSync(claudePath, 'utf-8'));
  }
  if (fs.existsSync(readmePath)) {
    triologue.setReadmeMd(fs.readFileSync(readmePath, 'utf-8'));
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    const controller = agentIO.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    // No active LLM call - safe to exit
    console.log(chalk.yellow('\nShutting down...'));
    process.send!({ type: 'exit' });
  });

  // Emit ready signal for Coordinator
  process.send({ type: 'ready' });

  // Main REPL loop
  while (true) {
    try {
      // Use initial query from restored session, or prompt for input
      let query: string;
      if (initialQuery !== null) {
        query = initialQuery;
        initialQuery = null; // Clear after first use
        console.log(chalk.gray(`Restored query: ${query.slice(0, 50)}${query.length > 50 ? '...' : ''}`));
      } else {
        query = await agentIO.ask(chalk.bgYellow.black('agent >> '), true);
      }

      // Handle multi-line input (trailing backslash)
      if (query.endsWith('\\') && query.trim() !== '\\') {
        const initialContent = query.slice(0, -1);
        const content = await openMultilineEditor(initialContent);
        if (content === null) {
          console.log(chalk.gray('Multi-line input cancelled.'));
          continue;
        }
        query = content;
      }

      // handle exit
      if (['q', 'exit', 'quit', ''].includes(query.trim().toLowerCase())) {
        break;
      }

      // Handle bang commands
      if (query.trim().startsWith('!')) {
        const command = query.trim().slice(1).trim();
        const result = await loader.execute('tmux', ctx, {
          command: command || undefined,
          reason: command ? `User runs: ${command}` : 'Open terminal',
        });
        triologue.user(`[FYI] ${result}`);
        triologue.resetHint();
        continue;
      }

      // Handle slash commands
      const trimmedQuery = query.trim();
      if (trimmedQuery.startsWith('/')) {
        const parts = trimmedQuery.split(/\s+/);
        const cmdName = parts[0].slice(1); // Remove '/'

        const slashCtx: SlashCommandContext = {
          query: trimmedQuery,
          args: parts,
          ctx,
          triologue,
          sessionFilePath,
        };

        const handled = await slashRegistry.execute(cmdName, slashCtx);
        if (handled && slashCtx.nextQuery) {
          // /load returned a first query to process
          query = slashCtx.nextQuery;
        } else {
          continue;
        }
      }

      // Add user message (reset hint flag for new query)
      triologue.user(query);
      triologue.resetHint();

      // Build and set skill hint (temporary, not in transcript)
      const skillHint = await buildSkillHint(query, ctx);
      if (skillHint) {
        triologue.setTemporaryHint(skillHint);
      }

      // Capture first query as bookmark title
      if (!firstQueryCaptured) {
        const session = readSession(sessionFilePath);
        if (session && !session.first_query) {
          session.first_query = query.slice(0, 100);
          writeSession(sessionFilePath, session);
          firstQueryCaptured = true;
        }
      }

      // Run agent loop
      await agentLoop(triologue, ctx);

      // Print final response in letter-style box
      const lastMsg = triologue.getMessagesRaw().at(-1);
      if (lastMsg?.content) {
        displayLetterBox(lastMsg.content);
      }
    } catch (err) {
      // Shutdown - exit cleanly (only Ctrl+C triggers this)
      if (err instanceof ShutdownError) {
        break;
      }

      // Readline closed (race condition on SIGINT/SIGTERM) - exit cleanly
      if (err instanceof Error && err.message === 'readline was closed') {
        break;
      }

      // All other errors - prompt user for retry instead of exiting
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorType = classifyError(err);

      console.error();
      console.error(chalk.red(`Error: ${errorMessage}`));

      // Show helpful instructions based on error type
      if (errorType === 'auth') {
        console.error(chalk.yellow('Check OLLAMA_API_KEY in ~/.mycc-store/.env file.'));
      } else if (errorType === 'model') {
        console.error(chalk.yellow(`Check OLLAMA_MODEL in ~/.mycc-store/.env file. Current: ${MODEL}`));
      } else if (errorType === 'config') {
        console.error(chalk.yellow('Check TOKEN_THRESHOLD in ~/.mycc-store/.env file.'));
      } else if (errorType === 'transient') {
        console.error(chalk.yellow('This appears to be a network/transient error.'));
      }

      // Prompt user for action
      console.log(chalk.gray('─'.repeat(40)));
      const answer = await agentIO.ask(chalk.cyan('Retry? [Y/n] > '));

      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        console.log(chalk.yellow('Exiting at user request.'));
        break;
      }

      // User wants to retry - continue the loop
      console.log(chalk.cyan('Retrying...'));
      continue;
    }
  }

  // Signal Coordinator to exit (which will kill this process)
  process.send({ type: 'exit' });
}