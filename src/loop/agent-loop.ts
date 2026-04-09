/**
 * agent-loop.ts - STAR-principle agent loop
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { retryChat, MODEL, OLLAMA_HOST, isTransientError } from '../ollama.js';
import type { AgentContext, ToolScope, ToolCall, SlashCommandContext } from '../types.js';
import { ParentContext } from '../context/index.js';
import { Loader } from '../context/loader.js';
import { clearSessionData, getMyccDir } from '../context/db.js';
import { createSessionFile, readSession, writeSession, getSessionId, cleanupEmptySessions } from '../session/index.js';
import { slashRegistry } from '../slashes/index.js';
import { TOKEN_THRESHOLD, buildSystemPrompt } from './agent-prompts.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';

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
  loader: Loader,
  scope: ToolScope = 'main'
): Promise<void> {
  let nextTodoNudge = 3;
  let lastTodoState = '';

  while (!agentIO.isShuttingDown()) {
    try {
      // 1. Handle pending questions from children
      await ctx.team.handlePendingQuestions();

      // 2. Collect mails (collated into single user message)
      const mails = ctx.mail.collectMails();
      if (mails.length > 0) {
        const mailContent = mails
          .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
          .join('\n\n---\n\n');
        triologue.user(mailContent);
      }

      // 2.5 Generate hint round if threshold reached
      if (triologue.needsHintRound()) {
        console.log(chalk.blue('[hint round] Generating problem analysis...'));
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

      triologue.setSystemPrompt(buildSystemPrompt(ctx));

      const response = await retryChat({
        model: MODEL,
        messages: triologue.getMessages(),
        tools: loader.getToolsForScope(scope),
      });

      // 5. Handle response
      const assistantMessage = response.message;
      triologue.agent(assistantMessage.content || '', assistantMessage.tool_calls as ToolCall[] | undefined);

      // 6. No tool calls = check team status
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        const { allSettled, hasQuestion } = await ctx.team.awaitTeam(30000);

        // Priority 1: If there's pending question / mail, continue to next iteration
        if (hasQuestion || ctx.mail.hasNewMails()) {
          continue;
        }

        // Priority 2: If all teammates are settled (idle/shutdown), we're done
        if (allSettled) {
          return;
        }

        // Priority 3: Timeout waiting for teammates - inject status message and retry
        triologue.user(`Timeout waiting for teammates. What will you do? ${ctx.team.printTeam()}`);
        continue;
      }

      // 7. Execute tools
      for (const toolCall of (assistantMessage.tool_calls as ToolCall[])) {
        if (agentIO.isShuttingDown()) {
          throw new ShutdownError();
        }

        const toolCallId = toolCall.id;
        const args = toolCall.function.arguments as Record<string, unknown>;
        const toolName = toolCall.function.name;

        const output = await loader.execute(toolName, ctx, args);

        triologue.tool(toolName, output, toolCallId);
        triologue.onToolResult(toolName, args, output);
      }
    } catch (err) {
      // Check if we should exit (shutdown or non-recoverable)
      if (err instanceof ShutdownError || agentIO.isShuttingDown()) {
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Teammate timeout - give LLM context and options to decide
      if (err instanceof Error && errorMessage.includes('Timeout waiting for teammate')) {
        console.error(chalk.yellow(`[agent-loop] Recoverable error: ${errorMessage}`));
        triologue.user(`Timeout waiting for teammates. What will you do? ${ctx.team.printTeam()}\n\nOptions:\n- Wait longer (use tm_await with higher timeout)\n- Remove teammate (use tm_remove)\n- Continue without waiting (just proceed with other tasks)`);
        continue;
      }

      // Check if transient error (network/LLM issues) - should auto-retry
      if (isTransientError(err)) {
        console.error(chalk.yellow(`[agent-loop] Recoverable error: ${errorMessage}`));
        triologue.user(`An error occurred: ${errorMessage}. Please try again.`);
        continue;
      }

      // Non-transient, non-shutdown error - propagate
      throw err;
    }
  }

  // Exited due to shutdown
  throw new ShutdownError();
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  console.log(chalk.cyan('Coding Agent v1.0'));
  console.log(chalk.cyan(`Model: ${MODEL} (${OLLAMA_HOST})`));
  console.log('Commands: /team, /issues, /todos, /skills, /exit\n');

  // Clear session data for clean startup
  clearSessionData();

  // Triologue for message management (persisted to disk)
  const transcriptDir = path.join(getMyccDir(), 'transcripts');
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const triologuePath = path.join(transcriptDir, `lead-${timestamp}-triologue.jsonl`);
  fs.writeFileSync(triologuePath, '', 'utf-8');

  // Create a new session file for this run
  const sessionFilePath = createSessionFile(triologuePath);
  console.log(chalk.gray(`Session: ${path.basename(sessionFilePath)}`));

  // Clean up empty session files from previous runs
  const currentSessionId = getSessionId(sessionFilePath);
  const removed = cleanupEmptySessions(currentSessionId);
  if (removed > 0) {
    console.log(chalk.gray(`Cleaned up ${removed} empty session(s)`));
  }

  // Set default editor to xdg-open if not configured
  if (!process.env.EDITOR && !process.env.VISUAL) {
    process.env.EDITOR = 'xdg-open';
  }

  // Track first query for bookmark title
  let firstQueryCaptured = false;

  const triologue = new Triologue({
    tokenThreshold: TOKEN_THRESHOLD,
    onMessage: (messages) => {
      const lastMsg = messages[messages.length - 1];
      try {
        fs.appendFileSync(triologuePath, JSON.stringify(lastMsg) + '\n', 'utf-8');
      } catch {
        // Ignore write errors
      }
    },
  });

  // Create loader
  const loader = new Loader();
  await loader.loadAll();
  loader.watchDirectories();

  // Create context with loader
  const ctx = new ParentContext(loader, sessionFilePath);
  ctx.initializeIpcHandlers();

  // Initialize AgentIO for main process
  agentIO.initMain();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    if (agentIO.abort()) {
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    // No active tool - safe to exit
    console.log(chalk.yellow('\nShutting down...'));
    ctx.team.dismissTeam();
    agentIO.close();
    process.exit(0);
  });

  // Main REPL loop
  while (!agentIO.isShuttingDown()) {
    try {
      let query = await agentIO.ask(chalk.bgYellow.black('agent >> '));
      // handle exit
      if (['q', 'exit', 'quit', ''].includes(query.trim().toLowerCase())) {
        break;
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
      await agentLoop(triologue, ctx, loader);

      // Print final response
      const lastMsg = triologue.getMessagesRaw().at(-1);
      if (lastMsg?.content) {
        console.log(lastMsg.content);
      }
      console.log();
    } catch (err) {
      // Shutdown - exit cleanly
      if (err instanceof ShutdownError || agentIO.isShuttingDown()) {
        break;
      }

      // Fatal errors - log and exit
      if (err instanceof Error) {
        console.error(chalk.red(`Fatal error: ${err.message}`));
        if (err.stack) {
          console.error(chalk.gray(err.stack));
        }
      } else {
        console.error(chalk.red('Fatal error:'), err);
      }
      break;
    }
  }

  // Cleanup
  ctx.team.dismissTeam();
  agentIO.close();
  loader.stopWatching();
}