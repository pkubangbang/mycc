#!/usr/bin/env node
/**
 * teammate-worker.ts - Worker process for autonomous teammates
 *
 * Runs as a child process spawned by TeamManager.
 * Uses child-context for IPC-based operations.
 */

import { createChildContext } from './child-context/index.js';
import { createLoader, createToolLoader } from './loader.js';
import { ollama, MODEL } from '../ollama.js';
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
import {
  sendStatus,
  sendLog,
  sendError,
  handleDbResult,
  inboxMessages,
} from './child-context/ipc-helpers.js';
import type { TeammateStatus } from '../types.js';

const WORKDIR = process.cwd();
const POLL_INTERVAL = 5000; // 5 seconds
const IDLE_TIMEOUT = 60000; // 60 seconds

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

    // 2. Collect mails (mailbox + IPC messages)
    const mails = ctx.mail.collectMails();
    for (const mail of mails) {
      messages.push({
        role: 'user',
        content: `Mail from ${mail.from}: ${mail.title}\n${mail.content}`,
      });
    }

    // 3. Process queued mail messages
    const pending = [...inboxMessages];
    inboxMessages.length = 0;
    for (const msg of pending) {
      // Only mail messages are queued now; db_result and shutdown handled immediately
      const message = msg as unknown as { from: string; title: string; content: string };
      messages.push({
        role: 'user',
        content: `Mail from ${message.from}: ${message.title}\n${message.content}`,
      });
    }

    // 4. Todo nudging
    if (ctx.todo.hasOpenTodo()) {
      messages.push({
        role: 'user',
        content: `<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`,
      });
    }

    // 5. Auto-compact when tokens exceed threshold
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      sendLog('[auto-compact triggered]');
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
      messages.unshift({ role: 'user', content: makeIdentityBlock(teammateName, teammateRole, WORKDIR) });
    }

    // 6. Build system prompt and call LLM
    const SYSTEM = buildSystemPrompt(ctx, { name: teammateName, role: teammateRole });
    const response = await ollama.chat({
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

    // 7. No tool calls = enter idle state
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const result = await enterIdleState(messages);
      if (result === 'shutdown') {
        process.exit(0);
      }
      // Resume work phase
      continue;
    }

    // 8. Execute tools
    for (const tc of assistantMessage.tool_calls) {
      const toolName = tc.function.name;
      const args = tc.function.arguments as Record<string, unknown>;

      try {
        const output = await toolLoader.execute(toolName, ctx, args);
        sendLog(`${toolName}: ${output.slice(0, 100)}`);
        messages.push({
          role: 'tool',
          content: `tool call ${toolName} finished.\n${output}`,
        });
      } catch (err) {
        const errorMsg = (err as Error).message;
        sendError(`${toolName}: ${errorMsg}`);
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
  const startTime = Date.now();

  while (Date.now() - startTime < IDLE_TIMEOUT && !shutdownRequested) {
    // 1. Check for shutdown
    if (shutdownRequested) {
      sendStatus('shutdown');
      return 'shutdown';
    }

    // 2. Check for new mail messages
    if (inboxMessages.some((m) => m.type === 'message')) {
      sendStatus('working');
      return 'resume';
    }

    // 3. Check mailbox for new mail
    const mails = ctx.mail.collectMails();
    if (mails.length > 0) {
      sendStatus('working');
      return 'resume';
    }

    // 4. Auto-claim unclaimed issues
    const issues = await ctx.issue.listIssues();
    const unclaimed = issues.filter(
      (issue) => issue.status === 'pending' && !issue.owner && issue.blockedBy.length === 0
    );

    if (unclaimed.length > 0) {
      const issue = unclaimed[0];
      try {
        const claimed = await ctx.issue.claimIssue(issue.id, teammateName);
        if (claimed) {
          sendLog(`Auto-claimed issue #${issue.id}: ${issue.title}`);
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
        sendLog(`Failed to claim issue #${issue.id}: ${(err as Error).message}`);
      }
    }

    // 5. Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  // Timeout or shutdown requested
  if (shutdownRequested) {
    sendLog('Shutdown requested, exiting');
  } else {
    sendLog('Idle timeout reached, exiting');
  }
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
  sendLog(`Worker ${teammateName} initializing...`);

  // Create child context
  ctx = createChildContext(teammateName, WORKDIR);

  // Load tools and skills
  const loader = createLoader();
  await loader.loadAll();
  toolLoader = createToolLoader(loader);

  sendLog(`Worker ${teammateName} started successfully`);

  // Run the teammate loop with the prompt
  await teammateLoop(msg.prompt);
}

// === IPC Message Listener ===
process.on('message', (msg: { type: string; [key: string]: unknown }) => {
  if (msg.type === 'spawn') {
    handleSpawn(msg as unknown as { name: string; role: string; prompt: string }).catch((err) => {
      sendError(`Spawn failed: ${(err as Error).message}`);
      process.exit(1);
    });
  } else if (msg.type === 'db_result') {
    // Handle IPC responses immediately - they resolve pending requests
    handleDbResult(msg as unknown as { reqId: number; success: boolean; data?: unknown; error?: string });
  } else if (msg.type === 'shutdown') {
    // Soft shutdown - set flag and let current work finish
    shutdownRequested = true;
  } else if (msg.type === 'message') {
    // Queue mail messages for teammate loop to process
    inboxMessages.push(msg);
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

// Log that worker is ready
sendLog('Worker process started, waiting for spawn message');