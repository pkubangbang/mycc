/**
 * agent-loop.ts - STAR-principle agent loop
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { ollama, MODEL } from '../ollama.js';
import type { Message } from 'ollama';
import type { AgentContext, ToolScope } from '../types.js';
import { ToolLoaderImpl } from '../context/loader.js';
import { createAgentContext } from '../context/index.js';
import { createLoader, createToolLoader } from '../context/loader.js';

const TOKEN_THRESHOLD = 50000; // Rough token limit before compacting

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      total += msg.content.split(/\s+/).length;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += JSON.stringify(tc.function.arguments).split(/\s+/).length;
      }
    }
  }
  return total;
}

/**
 * Micro-compact: collapse consecutive tool results
 */
function microCompact(messages: Message[]): void {
  // Find consecutive tool messages and combine them
  const newMessages: Message[] = [];
  let pendingTools: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      pendingTools.push(msg);
    } else {
      if (pendingTools.length > 0) {
        // Combine pending tools into a single user message
        const combined = pendingTools.map((m) => m.content).join('\n---\n');
        newMessages.push({ role: 'user', content: `Previous tool results:\n${combined}` });
        pendingTools = [];
      }
      newMessages.push(msg);
    }
  }

  // Handle any remaining pending tools
  if (pendingTools.length > 0) {
    const combined = pendingTools.map((m) => m.content).join('\n---\n');
    newMessages.push({ role: 'user', content: `Previous tool results:\n${combined}` });
  }
}

/**
 * Auto-compact: summarize old messages
 * For now, just keep the last N messages
 */
async function autoCompact(messages: Message[]): Promise<Message[]> {
  // Keep system and last 10 messages
  if (messages.length <= 10) {
    return messages;
  }

  // Create a summary message
  const summary = `[Context compacted. ${messages.length} messages summarized. Continue from current state.]`;

  return [
    messages[0], // System message
    { role: 'user', content: summary },
    ...messages.slice(-10),
  ];
}

/**
 * Build system prompt
 */
function buildSystemPrompt(ctx: AgentContext): string {
  const workDir = ctx.core.getWorkDir();
  const skills = ctx.skill.printSkills();
  const team = ctx.team.printTeam();

  return `You are a coding agent at ${workDir}.
Use tools to finish tasks. Use skills to access specialized knowledge.

Consider using issue_* to divide and conquor complex tasks, using todo_* for simple task tracking.

Read README.md or CLAUDE.md first if you feel lost about the context.

You must ask for grant BEFORE "git commit" with no exception.

Skills: ${skills}

${team !== 'No teammates.' ? `You have a team. Team status:\n${team}\n` : ''}

`;
}

/**
 * Agent loop - STAR principle: Situation, Task, Action, Result
 */
export async function agentLoop(
  messages: Message[],
  ctx: AgentContext,
  toolLoader: ToolLoaderImpl,
  scope: ToolScope = 'main'
): Promise<void> {
  let nextTodoNudge = 3;

  while (true) {
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

    // 9. Execute tools
    for (const toolCall of assistantMessage.tool_calls) {
      const args = toolCall.function.arguments as Record<string, unknown>;
      const toolName = toolCall.function.name;

      const output = await toolLoader.execute(toolName, ctx, args);

      messages.push({
        role: 'tool',
        content: `tool call ${toolName} finished.\n${output}`,
      });
    }
  }
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

  // REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // Inject prompt function into Core for question capability
  ctx.core.setQuestionFn(prompt);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\nShutting down...'));
    ctx.team.dismissTeam();
    rl.close();
    process.exit(0);
  });

  while (true) {
    try {
      const query = await prompt(chalk.cyan('agent >> '));

      if (['q', 'exit', 'quit', ''].includes(query.trim().toLowerCase())) {
        break;
      }

      // Handle commands
      if (query.trim() === '/team') {
        console.log(ctx.team.printTeam());
        continue;
      }

      if (query.trim() === '/issues') {
        console.log(ctx.issue.printIssues());
        continue;
      }

      if (query.trim() === '/todos') {
        console.log(ctx.todo.printTodoList());
        continue;
      }

      if (query.trim() === '/skills') {
        console.log(ctx.skill.printSkills());
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
      console.error('Error:', err);
    }
  }

  // Cleanup
  ctx.team.dismissTeam();
  rl.close();
  loader.stopWatching();
}