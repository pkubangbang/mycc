/**
 * agent-loop.ts - STAR-principle agent loop
 */

import chalk from 'chalk';
import { ollama, MODEL } from '../ollama.js';
import type { Message } from 'ollama';
import type { AgentContext, ToolScope } from '../types.js';
import { ToolLoaderImpl } from '../context/loader.js';
import { createAgentContext } from '../context/index.js';
import { createLoader, createToolLoader } from '../context/loader.js';
import {
  TOKEN_THRESHOLD,
  estimateTokens,
  microCompact,
  autoCompact,
  buildSystemPrompt,
} from './agent-utils.js';
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
 * Check if error is recoverable (should continue loop) or fatal (should propagate)
 */
function isRecoverableError(err: unknown): boolean {
  if (err instanceof ShutdownError) return false;
  if (agentIO.isShuttingDown()) return false;

  // Network/LLM errors are recoverable
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('etimedout')) return true;
    if (msg.includes('enotfound')) return true;
    if (msg.includes('rate limit')) return true;
    if (msg.includes('timeout')) return true;
  }

  return false;
}

/**
 * Agent loop - STAR principle: Situation, Task, Action, Result
 * @throws ShutdownError when agent is shutting down
 */
export async function agentLoop(
  messages: Message[],
  ctx: AgentContext,
  toolLoader: ToolLoaderImpl,
  scope: ToolScope = 'main'
): Promise<void> {
  let nextTodoNudge = 3;

  while (!agentIO.isShuttingDown()) {
    try {
      // 1. Micro-compact old tool results
      microCompact(messages);

      // 2. Collect mails
      const mails = ctx.mail.collectMails();
      for (const mail of mails) {
        messages.push({
          role: 'user',
          content: `Mail from ${mail.from}: ${mail.title}\n${mail.content}`,
        });
        messages.push({ role: 'assistant', content: 'Noted.' });
      }

      // 3. Todo nudging
      if (ctx.todo.hasOpenTodo()) {
        nextTodoNudge--;
        if (nextTodoNudge === 0) {
          messages.push({
            role: 'user',
            content: `<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`,
          });
          nextTodoNudge = 3;
        }
      }

      // 4. Auto-compact when tokens exceed threshold
      if (estimateTokens(messages) > TOKEN_THRESHOLD) {
        console.log(chalk.blue('[auto-compact triggered]'));
        const compacted = await autoCompact(messages);
        messages.splice(0, messages.length, ...compacted);
      }

      // 5. Build system prompt
      const SYSTEM = buildSystemPrompt(ctx);

      // 6. Call LLM
      const response = await ollama.chat({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM }, ...messages],
        tools: toolLoader.getToolsForScope(scope),
      });

      // 7. Handle response
      const assistantMessage = response.message;
      messages.push({
        role: 'assistant',
        content: assistantMessage.content || '',
        tool_calls: assistantMessage.tool_calls,
      });

      // 8. No tool calls = check team status
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // Only check team if it exists (not in child process)
        if (ctx.team) {
          const result = await ctx.team.awaitTeam(30000);
          if (result.allSettled) {
            return;
          }

          messages.push({
            role: 'user',
            content: `Timeout waiting for teammates. ${ctx.team.printTeam()}`,
          });
          continue;
        }
        // No team means single agent - just return
        return;
      }

      // 9. Execute tools
      for (const toolCall of assistantMessage.tool_calls) {
        if (agentIO.isShuttingDown()) {
          throw new ShutdownError();
        }

        const args = toolCall.function.arguments as Record<string, unknown>;
        const toolName = toolCall.function.name;

        const output = await toolLoader.execute(toolName, ctx, args);

        messages.push({
          role: 'tool',
          content: `tool call ${toolName} finished.\n${output}`,
        });
      }
    } catch (err) {
      // Check if we should exit
      if (err instanceof ShutdownError || !isRecoverableError(err)) {
        throw err;
      }
      // Recoverable error - log and continue
      console.error(chalk.yellow(`[agent-loop] Recoverable error: ${(err as Error).message}`));
      messages.push({
        role: 'user',
        content: `An error occurred: ${(err as Error).message}. Please try again.`,
      });
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

  // Load tools and skills
  const loader = createLoader();
  await loader.loadAll();
  loader.watchDirectories();

  const toolLoader = createToolLoader(loader);

  // History
  const history: Message[] = [];

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
  const slashCommands = ['/team', '/issues', '/todos', '/skills', '/exit'];

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

        // Unknown slash command - show available commands
        console.log(chalk.yellow(`Unknown command: ${trimmedQuery}`));
        console.log(chalk.gray(`Available commands: ${slashCommands.join(', ')}`));
        continue;
      }

      // Add user message
      history.push({ role: 'user', content: query });

      // Run agent loop
      await agentLoop(history, ctx, toolLoader);

      // Print final response
      const lastMsg = history[history.length - 1];
      if (lastMsg.content) {
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