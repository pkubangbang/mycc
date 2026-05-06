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
import { ChildContext, silentLoader } from './child-context.js';
import { retryChat, MODEL } from '../ollama.js';
import type { AgentContext, Message } from '../types.js';
import type { ToolCall } from '../types.js';
import { buildSystemPrompt } from '../loop/agent-prompts.js';
import { getTokenThreshold, getMyccDir } from '../config.js';
import { Triologue } from '../loop/triologue.js';
import { ipc, sendStatus } from './child/ipc-helpers.js';

const WORKDIR = process.cwd();
const POLL_INTERVAL = 5000; // 5 seconds
const CONFUSION_THRESHOLD = 10; // Same as main process
const MIN_MESSAGES_FOR_HINT = 6; // Same as main process

// State
let teammateName = '';
let teammateRole = '';
let ctx: AgentContext;
let shutdownRequested = false;
let triologuePath = '';
let pendingModeChange: 'plan' | 'normal' | null = null;

/**
 * Create a triologue that persists messages to disk
 * @param name - Teammate name (for fallback path generation)
 * @param assignedPath - Pre-assigned path from parent (optional)
 */
function createPersistentTriologue(name: string, assignedPath?: string): Triologue {
  const transcriptDir = path.join(getMyccDir(), 'transcripts');
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  // Use assigned path if provided, otherwise generate
  if (assignedPath) {
    triologuePath = assignedPath;
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    triologuePath = path.join(transcriptDir, `${name}-${timestamp}-triologue.jsonl`);
  }

  // Clear existing file on start
  fs.writeFileSync(triologuePath, '', 'utf-8');

  const triologue = new Triologue({
    tokenThreshold: getTokenThreshold(),
    onMessage: (messages: Message[]) => {
      // Append last message to file
      const lastMsg = messages[messages.length - 1];
      try {
        fs.appendFileSync(triologuePath, `${JSON.stringify(lastMsg)  }\n`, 'utf-8');
      } catch {
        // Ignore write errors
      }
    },
  });

  return triologue;
}

// === Main Teammate Loop ===
async function teammateLoop(prompt: string, triologuePathArg?: string): Promise<void> {
  const triologue = createPersistentTriologue(teammateName, triologuePathArg);
  triologue.user(prompt);

  const tools = silentLoader.getToolsForScope('child');
  // Send ready notification (path already registered by parent)
  ipc.sendNotification('teammate_ready', { name: teammateName });

  // Todo nudging state (counter-based, same as lead agent)
  let nextTodoNudge = 3;
  let lastTodoState = '';

  // Confusion tracking
  let nextBriefNudge = 5;

  // Tools that are purely exploratory (information gathering)
  const EXPLORATION_TOOLS = new Set([
    'read_file', 'web_search', 'web_fetch', 'brief', 'issue_list',
    'wt_print', 'bg_print', 'tm_print', 'question', 'recall',
  ]);

  // Tools that modify state (progress indicators)
  const ACTION_TOOLS = new Set([
    'write_file', 'edit_file', 'todo_write', 'issue_create', 'issue_close',
    'issue_claim', 'issue_comment', 'blockage_create', 'blockage_remove',
    'tm_create', 'tm_remove', 'wt_create', 'wt_remove', 'bg_create',
    'bg_remove', 'mail_to', 'broadcast', 'git_commit',
  ]);

  // Read-only bash commands (exploration)
  const READ_ONLY_BASH = /^(ls|cat|pwd|head|tail|wc|find|which|git\s+(status|log|diff|branch|show|ls-files))/;

  // Check if tool result indicates error
  function isErrorResult(result: string): boolean {
    if (!result) return false;
    const lower = result.toLowerCase();
    if (lower.startsWith('error:') || lower.startsWith('error ') || lower.startsWith('fatal:')) return true;
    if (/command failed with exit code \d+/.test(lower)) return true;
    if (lower.includes('eacces') || lower.includes('enoent') || lower.includes('eperm')) return true;
    if (lower.includes('permission denied')) return true;
    if (lower.includes('not found') || lower.includes('does not exist') || lower.includes('no such file')) return true;
    return false;
  }

  while (!shutdownRequested) {
    sendStatus('working');

    try {
      // 1. Collect mails from file-based mailbox (collated into single user message)
      const mails = ctx.mail.collectMails();
      if (mails.length > 0) {
        const mailContent = mails
          .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
          .join('\n\n---\n\n');
        triologue.user(mailContent);
      }

      // 2. Check for pending mode change notifications
      if (pendingModeChange) {
        if (pendingModeChange === 'normal') {
          triologue.user('<system-notification>Plan mode has ended. Code changes are now allowed. All tools (write_file, edit_file, bash) are fully functional. Proceed with your tasks.</system-notification>');
        } else {
          triologue.user('<system-notification>Plan mode is now active. Code changes are temporarily restricted. Continue with read-only operations while waiting.</system-notification>');
        }
        pendingModeChange = null;
      }

      // 3. Todo nudging with counter and state tracking
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
          const output = await silentLoader.execute(toolName, ctx, args);
          triologue.tool(toolName, output, tc.id);

          // Confusion scoring based on tool classification
          if (!EXPLORATION_TOOLS.has(toolName)) {
            if (toolName === 'bash') {
              const cmd = String(args?.command || '');
              if (!READ_ONLY_BASH.test(cmd)) {
                ctx.core.increaseConfusionIndex(-1);
              }
            } else if (ACTION_TOOLS.has(toolName)) {
              ctx.core.increaseConfusionIndex(-1);
            }
          }

          // Error results increase confusion
          if (isErrorResult(output)) {
            ctx.core.increaseConfusionIndex(2);
          }

          // Reset brief nudge on successful tool execution
          nextBriefNudge = 5;

        } catch (err) {
          const errorMsg = (err as Error).message;
          ctx.core.brief('error', toolName, errorMsg);
          triologue.tool(toolName, `error: ${errorMsg}`, tc.id);
          // Errors increase confusion
          ctx.core.increaseConfusionIndex(2);
        }
      }

      // 6. Check confusion threshold - send help request to lead if stuck
      const confusionIndex = ctx.core.getConfusionIndex();
      const messageCount = triologue.getMessagesRaw().length;
      if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
        const lastRole = triologue.getLastRole();
        if (lastRole === 'assistant' || lastRole === 'tool') {
          // Send help request to lead
          ctx.team.mailTo('lead', 'Stuck - need guidance',
            `I'm stuck (confusion index: ${confusionIndex}). ` +
            `Please provide guidance or clarify the next steps. ` +
            `Current state: ${ctx.todo.hasOpenTodo() ? ctx.todo.printTodoList() : 'No active todos'}`,
            ctx.core.getName());

          // Reset confusion after requesting help
          ctx.core.resetConfusionIndex();
        }
      }

      // 7. Brief nudging - remind agent to use brief tool
      nextBriefNudge--;
      if (nextBriefNudge <= 0) {
        triologue.user('<reminder>Provide a brief status update using the brief tool. Example: brief("Working on X", 7)</reminder>');
        nextBriefNudge = 5;
      }
    } catch (err) {
      // Log error but continue the loop - don't crash
      const errorMsg = (err as Error).message;
      ctx.core.brief('error', 'loop', `Error in main loop: ${errorMsg}. Recovering...`);

      // Add error to triologue so LLM knows what happened
      triologue.user(`<system-error>An error occurred: ${errorMsg}. Please continue with your task.</system-error>`);

      // Brief pause before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
    try {
      // 1. Check for shutdown
      if (shutdownRequested) {
        sendStatus('shutdown');
        return 'shutdown';
      }

      // 2. Check mailbox for new mail (file-based)
      if (ctx.mail.hasNewMails()) {
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
            ctx.core.brief('info', 'auto_claim', `Issue #${issue.id}: ${issue.title}`);
            // Identity is preserved in system prompt, no need to re-inject
            triologue.user(`<auto-claimed>Issue #${issue.id}: ${issue.title}\n${issue.content || ''}</auto-claimed>`);
            return 'resume';
          }
        } catch (err) {
          // Claim failed, another worker might have claimed it
          ctx.core.brief('info', 'auto_claim', `Failed to claim issue #${issue.id}: ${(err as Error).message}`);
        }
      }

      // 4. Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    } catch (err) {
      // Log error but continue polling - don't crash
      ctx.core.brief('error', 'idle', `Error in idle state: ${(err as Error).message}. Continuing...`);
      // Brief pause before continuing
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
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
  triologuePath?: string;
}): Promise<void> {
  teammateName = msg.name;
  teammateRole = msg.role;

  // Create child context
  ctx = new ChildContext(teammateName, WORKDIR);

  // Log initialization (ctx is now available)
  ctx.core.brief('info', 'worker', `${teammateName} initializing...`);

  // Load tools and skills (silent mode - suppress loading logs)
  await silentLoader.loadAll();

  ctx.core.brief('info', 'worker', `${teammateName} started successfully`);

  // Run the teammate loop with the prompt (and pre-assigned triologue path)
  await teammateLoop(msg.prompt, msg.triologuePath);
}

// === IPC Message Listener ===
process.on('message', (msg: { type: string;[key: string]: unknown }) => {
  if (msg.type === 'spawn') {
    handleSpawn(msg as unknown as { name: string; role: string; prompt: string; triologuePath?: string }).catch((err) => {
      // ctx may not be available yet, use sendNotification directly
      ipc.sendNotification('error', { error: `Spawn failed: ${(err as Error).message}` });
      process.exit(1);
    });
  } else if (msg.type === 'shutdown') {
    shutdownRequested = true;
  } else if (msg.type === 'mode_change') {
    // Handle mode change notification from parent
    const mode = msg.mode as 'plan' | 'normal';
    if (ctx?.core) {
      ctx.core.brief('info', 'mode_change', `Mode changed to: ${mode}`);
    }
    // Store for injection into triologue in the main loop
    pendingModeChange = mode;
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

// Handle SIGHUP (sent when parent process exits)
process.on('SIGHUP', () => {
  sendStatus('shutdown');
  process.exit(0);
});

// Log that worker is ready (before ctx is available, use sendNotification)
ipc.sendNotification('log', { message: 'Worker process started, waiting for spawn message' });

// === Global Error Handlers - Keep Worker Alive ===
process.on('uncaughtException', (err) => {
  // Log but don't exit - keep worker running
  ipc.sendNotification('error', { error: `Uncaught exception: ${err.message}` });
  // If ctx is available, also log via brief
  if (ctx?.core) {
    ctx.core.brief('error', 'worker', `Uncaught exception: ${err.message}. Worker continuing...`);
  }
});

process.on('unhandledRejection', (reason) => {
  // Log but don't exit - keep worker running
  const msg = reason instanceof Error ? reason.message : String(reason);
  ipc.sendNotification('error', { error: `Unhandled rejection: ${msg}` });
  // If ctx is available, also log via brief
  if (ctx?.core) {
    ctx.core.brief('error', 'worker', `Unhandled rejection: ${msg}. Worker continuing...`);
  }
});