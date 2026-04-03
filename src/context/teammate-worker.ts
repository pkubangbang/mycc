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

import { createChildContext } from './child-context/index.js';
import { createLoader, createToolLoader } from './loader.js';
import { retryChat, MODEL } from '../ollama.js';
import type { Message } from 'ollama';
import type { AgentContext } from '../types.js';
import type { ToolLoaderImpl } from './loader.js';
import {
  TOKEN_THRESHOLD,
  estimateTokens,
  microCompact,
  autoCompact,
  buildSystemPrompt,
  makeIdentityBlock,
} from '../loop/agent-utils.js';
import { ipc, sendStatus } from './child-context/ipc-helpers.js';

const WORKDIR = process.cwd();
const POLL_INTERVAL = 5000; // 5 seconds

// State
let teammateName = '';
let teammateRole = '';
let ctx: AgentContext;
let toolLoader: ToolLoaderImpl;
let shutdownRequested = false;

// === Main Teammate Loop ===
async function teammateLoop(prompt: string): Promise<void> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const tools = toolLoader.getToolsForScope('child');
  sendStatus('working');

  while (!shutdownRequested) {
    // 1. Micro-compact old tool results
    microCompact(messages);

    // 2. Collect mails from file-based mailbox
    const mails = ctx.mail.collectMails();
    for (const mail of mails) {
      messages.push({
        role: 'user',
        content: `Mail from ${mail.from}: ${mail.title}\n${mail.content}`,
      });
    }

    // 3. Todo nudging
    if (ctx.todo.hasOpenTodo()) {
      messages.push({
        role: 'user',
        content: `<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`,
      });
    }

    // 4. Auto-compact when tokens exceed threshold
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      ctx.core.brief('info', 'auto-compact', 'triggered');
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
      messages.unshift({ role: 'user', content: makeIdentityBlock(teammateName, teammateRole, WORKDIR) });
    }

    // 5. Build system prompt and call LLM
    const SYSTEM = buildSystemPrompt(ctx, { name: teammateName, role: teammateRole });
    const response = await retryChat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools,
    });

    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // 6. No tool calls = enter idle state
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const result = await enterIdleState(messages);
      if (result === 'shutdown') {
        process.exit(0);
      }
      // Resume work phase
      continue;
    }

    // 7. Execute tools
    for (const tc of assistantMessage.tool_calls) {
      const toolName = tc.function.name;
      const args = tc.function.arguments as Record<string, unknown>;

      try {
        const output = await toolLoader.execute(toolName, ctx, args);
        messages.push({
          role: 'tool',
          content: `tool call ${toolName} finished.\n${output}`,
        });
      } catch (err) {
        const errorMsg = (err as Error).message;
        ctx.core.brief('error', toolName, errorMsg);
        messages.push({
          role: 'tool',
          content: `tool call ${toolName} failed: ${errorMsg}`,
        });
      }
    }
  }

  // Graceful exit after shutdown requested
  sendStatus('shutdown');
  process.exit(0);
}

// === Idle State: Poll for new work ===
async function enterIdleState(messages: Message[]): Promise<'shutdown' | 'resume'> {
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
          // Identity re-injection if context is short
          if (messages.length <= 3) {
            messages.unshift({
              role: 'user',
              content: makeIdentityBlock(teammateName, teammateRole, WORKDIR),
            });
          }
          messages.push({
            role: 'user',
            content: `<auto-claimed>Issue #${issue.id}: ${issue.title}\n${issue.content || ''}</auto-claimed>`,
          });
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
  const loader = createLoader(true);
  await loader.loadAll();
  toolLoader = createToolLoader(loader);

  ctx.core.brief('info', 'worker', `${teammateName} started successfully`);

  // Run the teammate loop with the prompt
  await teammateLoop(msg.prompt);
}

// === IPC Message Listener ===
process.on('message', (msg: { type: string; [key: string]: unknown }) => {
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