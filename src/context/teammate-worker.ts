#!/usr/bin/env node
/**
 * teammate-worker.ts - Worker process for autonomous teammates
 *
 * Runs as a child process spawned by TeamManager.
 * Uses child-context for IPC-based operations.
 *
 * IPC is transient (request-response only).
 * Mail from teammates goes through ctx.mail (file-based).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildContext } from './child-context/index.js';
import { createLoader, Loader } from './loader.js';
import { retryChat, MODEL } from '../ollama.js';
import type { AgentContext, Message } from '../types.js';
import type { ToolCall } from '../types.js';
import { TOKEN_THRESHOLD, buildSystemPrompt } from '../loop/agent-prompts.js';
import { Triologue } from '../loop/triologue.js';
import { ipc, sendStatus } from './child-context/ipc-helpers.js';
import { getMyccDir } from './db.js';

const WORKDIR = process.cwd();
const POLL_INTERVAL = 5000; // 5 seconds

// State
let teammateName = '';
let teammateRole = '';
let ctx: AgentContext;
let loader: Loader;
let shutdownRequested = false;

/**
 * Create a triologue that persists messages to disk
 */
function createPersistentTriologue(name: string): Triologue {
  const transcriptDir = path.join(getMyccDir(), 'transcripts');
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const triologuePath = path.join(transcriptDir, `${name}-${timestamp}-triologue.jsonl`);

  // Clear existing file on start
  fs.writeFileSync(triologuePath, '', 'utf-8');

  return new Triologue({
    tokenThreshold: TOKEN_THRESHOLD,
    onMessage: (messages: Message[]) => {
      // Append last message to file
      const lastMsg = messages[messages.length - 1];
      try {
        fs.appendFileSync(triologuePath, JSON.stringify(lastMsg) + '\n', 'utf-8');
      } catch {
        // Ignore write errors
      }
    },
  });
}

// === Main Teammate Loop ===
async function teammateLoop(prompt: string): Promise<void> {
  const triologue = createPersistentTriologue(teammateName);
  triologue.user(prompt);

  const tools = loader.getToolsForScope('child');
  sendStatus('working');

  // Todo nudging state (counter-based, same as lead agent)
  let nextTodoNudge = 3;
  let lastTodoState = '';

  while (!shutdownRequested) {
    // 1. Collect mails from file-based mailbox (collated into single user message)
    const mails = ctx.mail.collectMails();
    if (mails.length > 0) {
      const mailContent = mails
        .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
        .join('\n\n---\n\n');
      triologue.user(mailContent);
    }

    // 2. Todo nudging with counter and state tracking
    if (ctx.todo.hasOpenTodo()) {
      const currentTodoState = ctx.todo.printTodoList();
      if (currentTodoState !== lastTodoState) {
        nextTodoNudge = 3; // Reset for new todo state
        lastTodoState = currentTodoState;
      }
      nextTodoNudge--;
      if (nextTodoNudge === 0) {
        triologue.user(`<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`);
        nextTodoNudge = 3;
      }
    }

    // 3. Build system prompt and call LLM
    // Ensure we have a valid message sequence before calling LLM
    const lastRole = triologue.getLastRole();
    if (lastRole === 'assistant') {
      // Last message was assistant with no tool calls - need user message before next LLM call
      // This can happen after resuming from idle without new input
      triologue.user('Continue with your task.');
    }

    triologue.setSystemPrompt(buildSystemPrompt(ctx, { name: teammateName, role: teammateRole }));

    const response = await retryChat({
      model: MODEL,
      messages: triologue.getMessages(),
      tools,
    });

    const assistantMessage = response.message;
    triologue.agent(assistantMessage.content || '', assistantMessage.tool_calls as ToolCall[] | undefined);

    // 4. No tool calls = enter idle state
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      // IMPORTANT: send finishing words to lead to coordinate.
      ctx.team.mailTo('lead', 'task done',
        assistantMessage.content ?? 'I have done my task, now running idle.', ctx.core.getName());

      const result = await enterIdleState(triologue);
      if (result === 'shutdown') {
        process.exit(0);
      }
      // Resume work phase
      continue;
    }

    // 5. Execute tools
    for (const tc of (assistantMessage.tool_calls as ToolCall[])) {
      const toolName = tc.function.name;
      const args = tc.function.arguments as Record<string, unknown>;

      try {
        const output = await loader.execute(toolName, ctx, args);
        triologue.tool(toolName, output, tc.id);
      } catch (err) {
        const errorMsg = (err as Error).message;
        ctx.core.brief('error', toolName, errorMsg);
        triologue.tool(toolName, `error: ${errorMsg}`, tc.id);
      }
    }
  }

  // Graceful exit after shutdown requested
  sendStatus('shutdown');
  process.exit(0);
}

// === Idle State: Poll for new work ===
async function enterIdleState(triologue: Triologue): Promise<'shutdown' | 'resume'> {
  sendStatus('idle');

  while (!shutdownRequested) {
    // 1. Check for shutdown
    if (shutdownRequested) {
      sendStatus('shutdown');
      return 'shutdown';
    }

    // 2. Check mailbox for new mail (file-based)
    if (ctx.mail.hasNewMails()) {
      sendStatus('working');
      return 'resume';
    }

    // 3. Auto-claim unclaimed issues that are not blocked
    const issues = await ctx.issue.listIssues();
    const unclaimed = issues.filter((issue) => {
      // Must be pending and unclaimed
      if (issue.status !== 'pending' || issue.owner) {
        return false;
      }
      // Must not be blocked by any incomplete issues
      if (issue.blockedBy.length > 0) {
        // Check if all blockers are completed
        const allBlockersComplete = issue.blockedBy.every((blockerId) => {
          const blocker = issues.find((i) => i.id === blockerId);
          return blocker && blocker.status === 'completed';
        });
        return allBlockersComplete;
      }
      return true;
    });

    if (unclaimed.length > 0) {
      const issue = unclaimed[0];
      try {
        const claimed = await ctx.issue.claimIssue(issue.id, teammateName);
        if (claimed) {
          ctx.core.brief('info', 'auto-claim', `Issue #${issue.id}: ${issue.title}`);
          // Identity is preserved in system prompt, no need to re-inject
          triologue.user(`<auto-claimed>Issue #${issue.id}: ${issue.title}\n${issue.content || ''}</auto-claimed>`);
          sendStatus('working');
          return 'resume';
        }
      } catch (err) {
        // Claim failed, another worker might have claimed it
        ctx.core.brief('info', 'auto-claim', `Failed to claim issue #${issue.id}: ${(err as Error).message}`);
      }
    }

    // 4. Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  // Shutdown requested
  sendStatus('shutdown');
  return 'shutdown';
}

// === Handle Spawn Message ===
async function handleSpawn(msg: {
  name: string;
  role: string;
  prompt: string;
}): Promise<void> {
  teammateName = msg.name;
  teammateRole = msg.role;

  // Create child context
  ctx = createChildContext(teammateName, WORKDIR);

  // Log initialization (ctx is now available)
  ctx.core.brief('info', 'worker', `${teammateName} initializing...`);

  // Load tools and skills (silent mode - suppress loading logs)
  loader = createLoader(true);
  await loader.loadAll();

  ctx.core.brief('info', 'worker', `${teammateName} started successfully`);

  // Run the teammate loop with the prompt
  await teammateLoop(msg.prompt);
}

// === IPC Message Listener ===
process.on('message', (msg: { type: string;[key: string]: unknown }) => {
  if (msg.type === 'spawn') {
    handleSpawn(msg as unknown as { name: string; role: string; prompt: string }).catch((err) => {
      // ctx may not be available yet, use sendNotification directly
      ipc.sendNotification('error', { error: `Spawn failed: ${(err as Error).message}` });
      process.exit(1);
    });
  } else if (msg.type === 'shutdown') {
    shutdownRequested = true;
  } else {
    // Handle request-response messages (db_result, etc.)
    ipc.handleMessage(msg);
  }
});

// === Process Lifecycle ===
process.on('disconnect', () => {
  sendStatus('shutdown');
  process.exit(0);
});

process.on('SIGTERM', () => {
  sendStatus('shutdown');
  process.exit(0);
});

process.on('SIGINT', () => {
  sendStatus('shutdown');
  process.exit(0);
});

// Log that worker is ready (before ctx is available, use sendNotification)
ipc.sendNotification('log', { message: 'Worker process started, waiting for spawn message' });