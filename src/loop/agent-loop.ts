/**
 * agent-loop.ts - STAR-principle agent loop
 */

import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { retryChat, MODEL, isTransientError } from '../ollama.js';
import type { Message, AgentContext, ToolScope, ToolCall } from '../types.js';
import { ToolLoaderImpl } from '../context/loader.js';
import { createAgentContext } from '../context/index.js';
import { createLoader, createToolLoader } from '../context/loader.js';
import { clearSessionData, getMyccDir } from '../context/db.js';
import { TOKEN_THRESHOLD, buildSystemPrompt } from './agent-prompts.js';
import { Trialogue } from './trialogue.js';
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
 * Format trialogue messages as markdown
 */
function formatTrialogueAsMarkdown(messages: import('../types.js').Message[], agentName: string = 'Lead Agent'): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  lines.push(`# Trialogue Dump - ${agentName}`);
  lines.push(`**Generated:** ${timestamp}`);
  lines.push('');

  for (const msg of messages) {
    lines.push('---');
    lines.push(`## ${msg.role.toUpperCase()}`);

    if (msg.content) {
      lines.push(msg.content);
    }

    if (msg.tool_calls) {
      lines.push('');
      lines.push('**Tool Calls:**');
      for (const tc of msg.tool_calls) {
        lines.push(`- \`${tc.function.name}\``);
        lines.push(`  - args: ${JSON.stringify(tc.function.arguments, null, 2)}`);
      }
    }

    if (msg.tool_name) {
      lines.push(`**Tool:** ${msg.tool_name}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Agent loop - STAR principle: Situation, Task, Action, Result
 * @throws ShutdownError when agent is shutting down
 */
export async function agentLoop(
  trialogue: Trialogue,
  ctx: AgentContext,
  toolLoader: ToolLoaderImpl,
  scope: ToolScope = 'main'
): Promise<void> {
  let nextTodoNudge = 3;
  let lastTodoState = '';

  while (!agentIO.isShuttingDown()) {
    try {
      // 1. Handle pending questions from children
      if (ctx.team) {
        await ctx.team.handlePendingQuestions();
      }

      // 2. Collect mails (collated into single user message)
      const mails = ctx.mail.collectMails();
      if (mails.length > 0) {
        const mailContent = mails
          .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
          .join('\n\n---\n\n');
        trialogue.user(mailContent);
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
          trialogue.user(`<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`);
          nextTodoNudge = 3;
        }
      }

      // 4. Build system prompt and call LLM
      // Ensure we have a valid message sequence before calling LLM
      const lastRole = trialogue.getLastRole();
      if (lastRole === 'assistant') {
        // Last message was assistant with no tool calls - need user message before next LLM call
        // This can happen after awaitTeam() returns without new input
        trialogue.user('Continue with your task.');
      }

      trialogue.setSystemPrompt(buildSystemPrompt(ctx));

      const response = await retryChat({
        model: MODEL,
        messages: trialogue.getMessages(),
        tools: toolLoader.getToolsForScope(scope),
      });

      // 5. Handle response
      const assistantMessage = response.message;
      trialogue.agent(assistantMessage.content || '', assistantMessage.tool_calls as ToolCall[] | undefined);

      // 6. No tool calls = check team status
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // Only check team if it exists (not in child process)
        if (ctx.team) {
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
          trialogue.user(`Timeout waiting for teammates. What will you do? ${ctx.team.printTeam()}`);
          continue;
        }
        // No team means single agent - just return
        return;
      }

      // 7. Execute tools
      for (const toolCall of (assistantMessage.tool_calls as ToolCall[])) {
        if (agentIO.isShuttingDown()) {
          throw new ShutdownError();
        }

        const toolCallId = toolCall.id;
        const args = toolCall.function.arguments as Record<string, unknown>;
        const toolName = toolCall.function.name;

        const output = await toolLoader.execute(toolName, ctx, args);

        trialogue.tool(toolName, output, toolCallId);
      }
    } catch (err) {
      // Check if we should exit (shutdown or non-recoverable)
      if (err instanceof ShutdownError || agentIO.isShuttingDown()) {
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Teammate timeout - give LLM context and options to decide
      if (err instanceof Error && errorMessage.includes('Timeout waiting for teammate') && ctx.team) {
        console.error(chalk.yellow(`[agent-loop] Recoverable error: ${errorMessage}`));
        trialogue.user(`Timeout waiting for teammates. What will you do? ${ctx.team.printTeam()}\n\nOptions:\n- Wait longer (use tm_await with higher timeout)\n- Remove teammate (use tm_remove)\n- Continue without waiting (just proceed with other tasks)`);
        continue;
      }

      // Check if transient error (network/LLM issues) - should auto-retry
      if (isTransientError(err)) {
        console.error(chalk.yellow(`[agent-loop] Recoverable error: ${errorMessage}`));
        trialogue.user(`An error occurred: ${errorMessage}. Please try again.`);
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
  console.log(`Model: ${MODEL}`);
  console.log('Commands: /team, /issues, /todos, /skills, /exit\n');

  // Create context
  const ctx = createAgentContext(process.cwd());

  // Clear session data for clean startup
  clearSessionData();;

  // Load tools and skills
  const loader = createLoader();
  await loader.loadAll();
  loader.watchDirectories();

  const toolLoader = createToolLoader(loader);

  // Trialogue for message management
  const trialogue = new Trialogue({ tokenThreshold: TOKEN_THRESHOLD });

  // Initialize AgentIO for main process
  agentIO.initMain();

  // Inject question function into Core for child process IPC
  ctx.core.setQuestionFn((query: string) => agentIO.question(query));

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    if (agentIO.abort()) {
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    // No active tool - safe to exit
    console.log(chalk.yellow('\nShutting down...'));
    ctx.team?.dismissTeam();
    agentIO.close();
    process.exit(0);
  });

  // Available slash commands
  const slashCommands = ['/team', '/issues', '/todos', '/skills', '/dump', '/exit'];

  // Main REPL loop
  while (!agentIO.isShuttingDown()) {
    try {
      const query = await agentIO.question(chalk.cyan('agent >> '));

      if (['q', 'exit', 'quit', ''].includes(query.trim().toLowerCase())) {
        break;
      }

      const trimmedQuery = query.trim();

      // Handle slash commands
      if (trimmedQuery.startsWith('/')) {
        if (trimmedQuery === '/team') {
          console.log(ctx.team?.printTeam() || 'No team.');
          continue;
        }

        if (trimmedQuery.startsWith('/issues')) {
          const parts = trimmedQuery.split(/\s+/);
          if (parts.length > 1) {
            // Show specific issue details
            const issueId = parseInt(parts[1], 10);
            if (isNaN(issueId)) {
              console.log(chalk.yellow(`Invalid issue ID: ${parts[1]}`));
            } else {
              console.log(await ctx.issue.printIssue(issueId));
            }
          } else {
            // Show all issues
            console.log(await ctx.issue.printIssues());
          }
          continue;
        }

        if (trimmedQuery === '/todos') {
          console.log(ctx.todo.printTodoList());
          continue;
        }

        if (trimmedQuery === '/skills') {
          console.log(ctx.skill.printSkills());
          continue;
        }

        if (trimmedQuery === '/dump' || trimmedQuery.startsWith('/dump ')) {
          const parts = trimmedQuery.split(/\s+/);
          const agentName = parts.length > 1 ? parts[1] : null;

          let messages: import('../types.js').Message[];
          let displayName: string;

          if (agentName) {
            // Dump teammate's trialogue from file
            const transcriptPath = path.join(getMyccDir(), 'transcripts', `${agentName}-trialogue.jsonl`);
            if (!fs.existsSync(transcriptPath)) {
              console.log(chalk.yellow(`No trialogue found for teammate '${agentName}'`));
              continue;
            }

            try {
              const content = fs.readFileSync(transcriptPath, 'utf-8');
              messages = content.trim().split('\n').map(line => JSON.parse(line));
              displayName = agentName;
            } catch (err) {
              console.log(chalk.red(`Error reading trialogue: ${(err as Error).message}`));
              continue;
            }
          } else {
            // Dump lead's trialogue from memory
            messages = trialogue.getMessages();
            displayName = 'Lead Agent';
          }

          const content = formatTrialogueAsMarkdown(messages, displayName);
          const timestamp = Math.floor(Date.now() / 1000);
          const filepath = path.join(os.tmpdir(), `dump-${timestamp}.md`);

          fs.writeFileSync(filepath, content);
          console.log(chalk.green(`Opening trialogue dump: ${filepath}`));

          // Open with default editor using agentIO.exec()
          const editor = process.env.EDITOR || process.env.VISUAL ||
            (process.platform === 'darwin' ? 'open' :
              process.platform === 'win32' ? 'start' : 'xdg-open');

          await agentIO.exec(async (signal) => {
            return new Promise((resolve) => {
              const child = spawn(editor, [filepath], {
                stdio: 'inherit',
                signal
              });
              child.on('close', () => resolve(true));
              child.on('error', () => resolve(false));
            });
          });

          // Cleanup temp file after editor closes
          try {
            fs.unlinkSync(filepath);
            console.log(chalk.gray(`Cleaned up: ${filepath}`));
          } catch {
            // Ignore cleanup errors
          }

          continue;
        }

        // Unknown slash command - show available commands
        console.log(chalk.yellow(`Unknown command: ${trimmedQuery}`));
        console.log(chalk.gray(`Available commands: ${slashCommands.join(', ')}`));
        continue;
      }

      // Add user message
      trialogue.user(query);

      // Run agent loop
      await agentLoop(trialogue, ctx, toolLoader);

      // Print final response
      const lastMsg = trialogue.getMessagesRaw().at(-1);
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
  ctx.team?.dismissTeam();
  agentIO.close();
  loader.stopWatching();
}