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
import { retryChat, MODEL } from '../engine/chat-provider.js';
import type { AgentContext, Message } from '../types.js';
import type { ToolCall } from '../types.js';
import { buildNormalModePrompt } from '../loop/agent-prompts.js';
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

// Budget/deadline tracking
let budgetSent = false;
let startTime = 0;
let hasDoneWork = false;
let deadlineMs = 0;        // Absolute deadline in ms (computed from eta)

// Heartbeat interval (30s)
const HEARTBEAT_INTERVAL_MS = 30_000;

// Time nudge every N rounds
const TIME_NUDGE_INTERVAL = 3;

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

  // Loop-scope tracking for time management
  let lastHeartbeatTime = Date.now();
  let nextTimeNudge = TIME_NUDGE_INTERVAL;

  // Tools that modify state (progress indicators)
  const ACTION_TOOLS = new Set([
    'write_file', 'edit_file', 'todo_create', 'todo_update', 'issue_create', 'issue_close',
    'issue_claim', 'issue_comment', 'blockage_create', 'blockage_remove',
    'tm_create', 'tm_remove', 'wt_create', 'wt_remove', 'bg_create',
    'bg_remove', 'mail_to', 'broadcast', 'git_commit',
  ]);

  // Read-only bash commands (exploration)
  const READ_ONLY_BASH = /^(ls|cat|pwd|head|tail|wc|find|which|git\s+(status|log|diff|branch|show|ls-files))/;

  // Track recent tool calls for repetition detection
  const recentToolCalls: string[] = [];

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

    const lastRole = triologue.getLastRole();

    try {

      // 1. Collect mails from file-based mailbox
      const mails = ctx.mail.collectMails();
      if (mails.length > 0) {
        const mailContent = mails
          .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
          .join('\n\n---\n\n');
        triologue.note('MAIL', mailContent);
      }

      // 2. Check for pending mode change notifications
      if (pendingModeChange) {
        if (pendingModeChange === 'normal') {
          triologue.note('SYSTEM_NOTIFICATION', 'Plan mode has ended. Code changes are now allowed. All tools (write_file, edit_file, bash) are fully functional. Proceed with your tasks.');
        } else {
          triologue.note('SYSTEM_NOTIFICATION', 'Plan mode is now active. Code changes are temporarily restricted. Continue with read-only operations while waiting.');
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
          triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
          nextTodoNudge = 3;
        }
      }

      // 4. Time reminder if budget is set (every N rounds)
      if (budgetSent) {
        nextTimeNudge--;
        if (nextTimeNudge <= 0) {
          nextTimeNudge = TIME_NUDGE_INTERVAL;
          const remaining = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
          triologue.note('REMINDER',
            `~${remaining}s left.` +
            (remaining < 30
              ? ` Send mail_to with a new eta to extend.`
              : ``));
        }
      }

      // 5. Build system prompt and call LLM
      // Ensure we have a valid message sequence before calling LLM
      if (lastRole === 'assistant') {
        // Last message was assistant with no tool calls - need user message before next LLM call
        // This can happen after resuming from idle without new input
        triologue.note('CONTINUE', 'Continue with your task.');
      }

      triologue.setSystemPrompt(buildNormalModePrompt(WORKDIR, { name: teammateName, role: teammateRole }));

      const response = await retryChat({
        model: MODEL,
        messages: triologue.getMessages(),
        tools,
      });

      const assistantMessage = response.message;
      const reasoningContent = (assistantMessage as unknown as Record<string, unknown>).reasoning_content as string | undefined;
      const toolCalls = assistantMessage.tool_calls as ToolCall[] | undefined;

      // Confusion scoring: +1 per assistant turn (agent spinning without progress)
      ctx.core.increaseConfusionIndex(1);

      // ---- No tools: guard against premature idle ----
      // No tool calls
      if (!toolCalls || toolCalls.length === 0) {
        // Register the assistant message (no tool calls to track)
        triologue.agent(assistantMessage.content || '', undefined, reasoningContent);

        if (!budgetSent) {
          // Never sent budget or did any work — re-prompt instead of idle
          nextBriefNudge = 5;
          const exampleEta = Math.floor(Date.now() / 1000 + 120);
          triologue.note('CONTINUE',
            `Request a time budget from lead via mail_to(name="lead", eta=${exampleEta}, ...).`);
          continue;
        }

        if (hasDoneWork) {
          // Actually did work and LLM says it's done — enter completing phase
          nextBriefNudge = 5;
          sendCompletionMail();
          const result = await enterIdleState(triologue);
          if (result === 'shutdown') {
            process.exit(0);
          }
          // Resume work phase
          continue;
        }

        // Has budget but no work done yet — re-prompt to use tools
        nextBriefNudge = 5;
        triologue.note('CONTINUE', 'Use tools to make progress on the task.');
        continue;
      }

      // There are tool calls — register assistant message with pending tool calls
      triologue.agent(assistantMessage.content || '', toolCalls, reasoningContent);

      // 5. Execute tools
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = tc.function.arguments as Record<string, unknown>;

        try {
          const output = await silentLoader.execute(toolName, ctx, args);
          triologue.tool(toolName, output, tc.id);

          // Track budget from mail_to call
          if (toolName === 'mail_to' && !budgetSent) {
            const eta = args?.eta as number | undefined;
            if (eta && eta > 0) {
              budgetSent = true;
              deadlineMs = Date.now() + eta * 1000;
              startTime = Date.now();
              lastHeartbeatTime = Date.now();
            }
          }

          // Heartbeat every 30s to lead
          if (budgetSent && (Date.now() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS)) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            ctx.team.mailTo('lead', `Progress: ${teammateName}`,
              `[PROGRESS] ${elapsed}s elapsed, still working.`);
            lastHeartbeatTime = Date.now();
          }

          // Track work done (non-exploration tools)
          if (!EXPLORATION_TOOLS.has(toolName)) {
            hasDoneWork = true;
          }

          // Confusion scoring based on tool classification
          // Check for repetition (same tool in last 5 calls)
          const isRepetition = recentToolCalls.includes(toolName);

          if (!EXPLORATION_TOOLS.has(toolName)) {
            if (toolName === 'bash') {
              const cmd = String(args?.command || '');
              if (!READ_ONLY_BASH.test(cmd)) {
                if (isRepetition) {
                  ctx.core.increaseConfusionIndex(1);
                } else {
                  ctx.core.increaseConfusionIndex(-1);
                }
              }
            } else if (ACTION_TOOLS.has(toolName)) {
              if (isRepetition) {
                // mail_to is highly confusing when repeated
                if (toolName === 'mail_to') {
                  ctx.core.increaseConfusionIndex(2);
                } else {
                  ctx.core.increaseConfusionIndex(1);
                }
              } else {
                ctx.core.increaseConfusionIndex(-1);
              }
            }
          }

          // Track recent tool calls (keep last 5)
          recentToolCalls.push(toolName);
          if (recentToolCalls.length > 5) {
            recentToolCalls.shift();
          }

          // Error results increase confusion
          if (isErrorResult(output)) {
            ctx.core.increaseConfusionIndex(2);
          }

          // Reset brief nudge only when brief tool is used
          if (toolName === 'brief') {
            nextBriefNudge = 5;
          }

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
        triologue.note('REMINDER', 'Provide a brief status update using the brief tool. Example: brief("Working on X", 7)');
        nextBriefNudge = 5;
      }
    } catch (err) {
      // Log error but continue the loop - don't crash
      const errorMsg = (err as Error).message;
      ctx.core.brief('error', 'loop', `Error in main loop: ${errorMsg}. Recovering...`);

      // Add error to triologue so LLM knows what happened
      triologue.note('SYSTEM_ERROR', `An error occurred: ${errorMsg}. Please continue with your task.`);

      // Brief pause before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Graceful exit after shutdown requested
  sendStatus('shutdown');
  process.exit(0);
}

/**
 * Send completion mail before entering idle
 */
function sendCompletionMail(): void {
  if (!budgetSent) return;
  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  ctx.team.mailTo('lead', `Results: ${teammateName}`,
    `[COMPLETE] ${teammateName} finished in ${elapsedSec}s\n` +
    `**Summary:** Task completed.\n`);
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
            triologue.note('AUTO_CLAIMED', `Issue #${issue.id}: ${issue.title}\n${issue.content || ''}`);
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
    // Note: Child processes (teammates) are always in normal mode
    // This notification is just for informational purposes
    const mode = msg.mode as 'plan' | 'normal';
    if (ctx?.core) {
      ctx.core.brief('info', 'mode_change', `Parent mode changed to: ${mode}`);
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