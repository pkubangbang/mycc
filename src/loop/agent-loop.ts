/**
 * agent-loop.ts - STAR-principle agent loop
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { retryChat, MODEL, OLLAMA_HOST, isTransientError, checkHealth, classifyError } from '../ollama.js';
import type { AgentContext, ToolScope, ToolCall, SlashCommandContext } from '../types.js';
import { ResultTooLargeError } from '../types.js';
import { ParentContext } from '../context/index.js';
import { Loader } from '../context/loader.js';
import { clearSessionData, getMyccDir, closeDb } from '../context/db.js';
import { createSessionFile, readSession, writeSession, getSessionId, cleanupEmptySessions, loadSessionById, getSessionPathById, SessionNotFoundError, AmbiguousSessionError } from '../session/index.js';
import { prepareRestoration, readDosq, extractFirstQuery, type SummaryPair } from '../session/restoration.js';
import { slashRegistry } from '../slashes/index.js';
import { TOKEN_THRESHOLD, buildSystemPrompt } from './agent-prompts.js';
import { Triologue } from './triologue.js';
import { agentIO } from './agent-io.js';
import { isVerbose, getSessionArg, shouldSkipHealthCheck } from '../config.js';
import { openMultilineEditor } from '../utils/multiline-input.js';

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
 * Result of session initialization
 */
interface SessionInit {
  sessionFilePath: string;
  triologuePath: string;
  restoredPair: SummaryPair | null;
  initialQuery: string | null;
}

/**
 * Initialize session - either restore from CLI arg or create new session
 */
async function initializeSession(): Promise<SessionInit> {
  const sessionArg = getSessionArg();
  let sessionFilePath: string;
  let triologuePath: string;
  let restoredPair: SummaryPair | null = null;
  let initialQuery: string | null = null;

  if (sessionArg) {
    console.log(chalk.cyan(`Loading session: ${sessionArg}`));

    let session: import('../session/types.js').Session;
    try {
      session = loadSessionById(sessionArg);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        console.error(chalk.red(`Session not found: ${sessionArg}`));
        process.exit(1);
      }
      if (err instanceof AmbiguousSessionError) {
        console.error(chalk.red(`Ambiguous session ID. Multiple matches found:`));
        for (const match of err.matches) {
          console.error(chalk.yellow(`  [${match.id.slice(0, 7)}] ${match.source} session`));
        }
        console.error(chalk.gray('Use a longer session ID prefix.'));
        process.exit(1);
      }
      throw err;
    }

    // Verify working directory matches session's project_dir
    const currentDir = process.cwd();
    if (currentDir !== session.project_dir) {
      console.error(chalk.red(`Working directory mismatch.`));
      console.error(chalk.yellow(`Current: ${currentDir}`));
      console.error(chalk.yellow(`Session expects: ${session.project_dir}`));
      console.error(chalk.gray(`Run: cd "${session.project_dir}" && mycc --session ${session.id}`));
      process.exit(1);
    }

    // Validate session files exist
    const validation = { valid: true, missingFiles: [] as string[] };
    if (!fs.existsSync(session.lead_triologue)) {
      validation.valid = false;
      validation.missingFiles.push(session.lead_triologue);
    }
    for (const p of session.child_triologues) {
      if (!fs.existsSync(p)) {
        validation.valid = false;
        validation.missingFiles.push(p);
      }
    }

    if (!validation.valid) {
      console.error(chalk.red(`Session files missing: ${validation.missingFiles.join(', ')}`));
      process.exit(1);
    }

    console.log(chalk.cyan('Restoring session...'));

    // Prepare restoration (summarize and generate DOSQ)
    const { pair, dosqPath } = await prepareRestoration(session);
    restoredPair = pair;

    console.log(chalk.cyan('Session restored. DOSQ generated at:'));
    console.log(chalk.gray(`  ${dosqPath}`));

    // Try to open DOSQ in editor
    try {
      const { openEditor } = await import('../utils/open-editor.js');
      openEditor([dosqPath]);
      console.log(chalk.gray('Opening DOSQ file in editor...'));
    } catch {
      console.log(chalk.yellow(`Please edit the DOSQ file manually: ${dosqPath}`));
    }

    console.log(chalk.yellow('Edit the DOSQ file if needed, then save and close to continue...'));

    // Wait for user to edit DOSQ
    await agentIO.ask(chalk.cyan('Press Enter when ready to continue > '));

    // Read DOSQ content and extract first query
    const dosqContent = readDosq(dosqPath);
    initialQuery = extractFirstQuery(dosqContent);

    // Use the session's existing triologue path
    triologuePath = session.lead_triologue;
    sessionFilePath = getSessionPathById(session.id) || path.join(path.dirname(session.lead_triologue), '..', 'sessions', `${session.id}.json`);

    console.log(chalk.gray(`Restored session: ${session.id.slice(0, 7)}`));
  } else {
    // Normal startup - create new session
    clearSessionData();

    // Triologue for message management (persisted to disk)
    const transcriptDir = path.join(getMyccDir(), 'transcripts');
    if (!fs.existsSync(transcriptDir)) {
      fs.mkdirSync(transcriptDir, { recursive: true });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    triologuePath = path.join(transcriptDir, `lead-${timestamp}-triologue.jsonl`);
    fs.writeFileSync(triologuePath, '', 'utf-8');

    // Create a new session file for this run
    sessionFilePath = createSessionFile(triologuePath);
    console.log(chalk.gray(`Session: ${path.basename(sessionFilePath)}`));

    // Clean up empty session files from previous runs
    const currentSessionId = getSessionId(sessionFilePath);
    const removed = cleanupEmptySessions(currentSessionId);
    if (removed > 0) {
      console.log(chalk.gray(`Cleaned up ${removed} empty session(s)`));
    }
  }

  return { sessionFilePath, triologuePath, restoredPair, initialQuery };
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

      const systemPrompt = buildSystemPrompt(ctx);
      triologue.setSystemPrompt(systemPrompt);

      // Verbose: Log system prompt
      if (isVerbose()) {
        console.log(chalk.magenta('[verbose][agent-loop] System prompt:'));
        console.log(chalk.gray(systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? '...' : '')));
      }

      // Create abort controller for this LLM call (allows Ctrl+C to interrupt)
      const abortController = agentIO.createLlmAbortController();

      try {
        const response = await retryChat(
          {
            model: MODEL,
            messages: triologue.getMessages(),
            tools: loader.getToolsForScope(scope),
          },
          { signal: abortController.signal }
        );

        // Clear abort controller after successful call
        agentIO.clearLlmAbortController();

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

          // Verbose: Log tool execution
          if (isVerbose()) {
            console.log(chalk.magenta(`[verbose][agent-loop] Executing tool: ${toolName}`));
            const argsPreview = JSON.stringify(args).slice(0, 200);
            console.log(chalk.gray(`  Args: ${argsPreview}${argsPreview.length >= 200 ? '...' : ''}`));
          }

          try {
            const output = await loader.execute(toolName, ctx, args);

            // Verbose: Log tool result
            if (isVerbose()) {
              console.log(chalk.magenta(`[verbose][agent-loop] Tool result: ${toolName}`));
              console.log(chalk.gray(`  Output length: ${output.length} chars`));
              const outputPreview = output.slice(0, 300);
              console.log(chalk.gray(`  Preview: ${outputPreview}${output.length > 300 ? '...' : ''}`));
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
          throw new ShutdownError('Interrupted by user');
        }

        throw err;
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

      // Classify error for appropriate handling
      const errorType = classifyError(err);

      switch (errorType) {
        case 'auth':
          console.error(chalk.red(`[agent-loop] Authentication error: ${errorMessage}`));
          console.error(chalk.red('Check OLLAMA_API_KEY in .env file.'));
          throw err;

        case 'model':
          console.error(chalk.red(`[agent-loop] Model error: ${errorMessage}`));
          console.error(chalk.red(`Check OLLAMA_MODEL in .env file. Current model: ${MODEL}`));
          throw err;

        case 'config':
          console.error(chalk.red(`[agent-loop] Configuration error: ${errorMessage}`));
          console.error(chalk.red('Check TOKEN_THRESHOLD in .env file.'));
          throw err;

        case 'transient':
          // Transient error - auto-retry by injecting into conversation
          console.error(chalk.yellow(`[agent-loop] Recoverable error: ${errorMessage}`));
          triologue.user(`An error occurred: ${errorMessage}. Please try again.`);
          continue;

        default:
          // Unknown/fatal error - propagate
          throw err;
      }
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

  // Health check: validate Ollama connectivity and model availability
  // Skip if --skip-healthcheck flag is set (useful for testing)
  if (shouldSkipHealthCheck()) {
    console.log(chalk.gray('Skipping health check (test mode)'));
  } else {
    const health = await checkHealth(TOKEN_THRESHOLD);
    if (!health.ok) {
      console.error(chalk.red(`Health check failed: ${health.error}`));
      process.exit(1);
    }

    // Display model info
    if (health.modelInfo) {
      const info = health.modelInfo;
      const parts = [info.name];
      if (info.family) parts.push(`family: ${info.family}`);
      if (info.parameterSize) parts.push(`params: ${info.parameterSize}`);
      parts.push(`ctx: ${info.contextLength}`);
      console.log(chalk.green(`✓ Model ready: ${parts.join(', ')}`));
      console.log(chalk.gray(`  Token threshold: ${TOKEN_THRESHOLD}`));
    }
  }

  console.log('Commands: /team, /issues, /todos, /skills, /exit\n');

  // Initialize AgentIO early (needed for ask() during session restoration)
  agentIO.initMain();

  // Initialize session (restore or create new)
  const sessionInit = await initializeSession();
  const { sessionFilePath, triologuePath, restoredPair } = sessionInit;
  let initialQuery = sessionInit.initialQuery; // Mutable for clearing after first use

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

  // If restored session, load the summary pair
  if (restoredPair !== null) {
    triologue.loadRestoration(restoredPair);
  }

  // Create loader
  const loader = new Loader();
  await loader.loadAll();
  loader.watchDirectories();

  // Create context with loader
  const ctx = new ParentContext(loader, sessionFilePath);
  ctx.initializeIpcHandlers();

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
    closeDb();
    process.exit(0);
  });

  // Emit ready signal for Coordinator (if running under coordinator)
  if (process.send) {
    process.send({ type: 'ready' });
  }

  // Main REPL loop
  while (!agentIO.isShuttingDown()) {
    try {
      // Use initial query from restored session, or prompt for input
      let query: string;
      if (initialQuery !== null) {
        query = initialQuery;
        initialQuery = null; // Clear after first use
        console.log(chalk.gray(`Restored query: ${query.slice(0, 50)}${query.length > 50 ? '...' : ''}`));
      } else {
        query = await agentIO.ask(chalk.bgYellow.black('agent >> '));
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
  closeDb();

  // Close stdin to signal completion to coordinator
  process.stdin.destroy();
}