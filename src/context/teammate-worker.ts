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
import { StreamAbortedError } from '../engine/chat-provider.js';
import type { AgentContext, Message } from '../types.js';
import type { ToolCall } from '../types.js';
import { buildNormalModePrompt } from '../loop/agent-prompts.js';
import { getTokenThreshold, getSessionContext, getSessionDir, setSessionContext, isVerbose } from '../config.js';
import { Triologue } from '../loop/triologue.js';
import { ipc, sendStatus } from './child/ipc-helpers.js';

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

// Working directory — set from spawn message (defaults to process.cwd())
let WORKDIR = process.cwd();

// Budget/deadline tracking
let budgetSent = false;
let startTime = 0;
let deadlineMs = 0;        // Absolute deadline in ms (computed from eta)

// Heartbeat interval (30s)
const HEARTBEAT_INTERVAL_MS = 30_000;

// Time nudge every N rounds
const TIME_NUDGE_INTERVAL = 3;

// === Per-turn watchdog ===
// Caps how long a single retryChat (main-loop turn OR compact summarization)
// may block. Without this, a hung/slow LLM call keeps status at 'working'
// forever and starves the cooperative mail poll at the top of the while-loop
// (see "stuck teammate" investigation: lead's mail sits unread in
// unread-{name}.jsonl until the ETA deadline). When the watchdog fires we
// abort the in-flight call, mail a WARNING to lead, inject a SYSTEM note, and
// let the loop continue so mail polling resumes.
//
// Budget-aware: when an ETA deadline is set we use a fraction of the REMAINING
// budget per turn so a single turn can never eat the whole budget. When no
// budget is set yet we fall back to a fixed cap.
const TURN_WATCHDOG_FALLBACK_MS = 180_000;   // 3 min cap when no ETA budget
const TURN_WATCHDOG_MIN_MS = 60_000;        // never shorter than 60s
const TURN_WATCHDOG_BUDGET_FRACTION = 0.5;  // use up to half of remaining budget

/**
 * Create a per-turn AbortController + deadline watchdog.
 * Returns the signal to pass into retryChat/compact, plus an abort() to call
 * on early completion (frees the timer) and the deadline ms (for logging).
 *
 * The watchdog aborts the call if it runs past the computed turn deadline.
 * Caller MUST call .abort(true) (manual=false) to release the timer once the
 * awaited call settles, otherwise the setTimeout keeps a dangling reference.
 */
function createTurnWatchdog(): {
  signal: AbortSignal;
  clearTimeout: () => void;
  deadlineMs: number;
} {
  // Compute remaining ETA budget (if known)
  let remaining = Infinity;
  if (budgetSent && deadlineMs > 0) {
    remaining = Math.max(0, deadlineMs - Date.now());
  }

  // Per-turn cap: half the remaining budget, bounded to [min, fallback].
  let cap: number;
  if (Number.isFinite(remaining)) {
    cap = Math.min(remaining * TURN_WATCHDOG_BUDGET_FRACTION, TURN_WATCHDOG_FALLBACK_MS);
    cap = Math.max(cap, TURN_WATCHDOG_MIN_MS);
  } else {
    cap = TURN_WATCHDOG_FALLBACK_MS;
  }

  const controller = new AbortController();
  const deadline = Date.now() + cap;
  const timer = setTimeout(() => controller.abort(), cap);

  // unref so the timer never keeps the worker process alive on its own
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    signal: controller.signal,
    clearTimeout: () => clearTimeout(timer),
    deadlineMs: deadline,
  };
}

/**
 * Mail a WARNING to the lead that this teammate's LLM turn timed out and was
 * aborted. Also injects a SYSTEM note into the triologue so the next turn
 * knows the previous turn was interrupted (prevents the LLM from assuming its
 * last attempt succeeded).
 */
function reportStuckTurn(reason: string, elapsedMs: number): void {
  const secs = Math.round(elapsedMs / 1000);
  const text = `Teammate "${teammateName}" appears stuck (${reason}) — LLM turn aborted after ${secs}s. ` +
    `Mail polling has resumed; if you sent mail it will be picked up on the next loop iteration. ` +
    `If this repeats, consider tm_remove to terminate or extend the ETA via mail_to.`;
  try {
    ctx.team.mailTo('lead', `WARNING: ${teammateName} stuck`, text);
  } catch {
    // mailTo may fail if ctx not ready — best-effort
  }
  try {
    ctx.core.brief('warn', 'watchdog', text);
  } catch {
    // ignore
  }
}

/**
 * Create a triologue that persists messages to disk
 * @param name - Teammate name (for fallback path generation)
 * @param assignedPath - Pre-assigned path from parent (optional)
 */
function createPersistentTriologue(name: string, assignedPath?: string): Triologue {
  // Use assigned path if provided, otherwise generate in session dir
  if (assignedPath) {
    triologuePath = assignedPath;
  } else {
    // Fallback: use session directory
    const sessionId = getSessionContext();
    const sessionDir = getSessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    triologuePath = path.join(sessionDir, `triologue-${name}-${timestamp}.jsonl`);
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

  // Record the triologue file path in the lead's transcript so /load can
  // recover it directly from the lead JSONL. This decouples session
  // restoration from tm_create positional alignment: the path is
  // self-reported by the teammate that actually created the file, and
  // lands in the lead's triologue as a [MAIL] note at the next COLLECT.
  // Format chosen to be greppable: "[READY] triologue file: <path>".
  ctx.team.mailTo('lead', 'Teammate ready',
    `[READY] triologue file: ${triologuePath}\nname: ${teammateName}`);

  // Todo nudging state (counter-based, same as lead agent)
  let nextTodoNudge = 3;
  let lastTodoState = '';

  // Confusion tracking
  let nextBriefNudge = 5;

  // Tools that are purely exploratory (information gathering)
  const EXPLORATION_TOOLS = new Set([
    'read_file', 'web_search', 'web_fetch', 'brief', 'issue_list',
    'bg_print', 'tm_print', 'question', 'recall',
  ]);

  // Loop-scope tracking for time management
  let lastHeartbeatTime = Date.now();
  let nextTimeNudge = TIME_NUDGE_INTERVAL;

  // Tools that modify state (progress indicators)
  const ACTION_TOOLS = new Set([
    'write_file', 'edit_file', 'todo_create', 'todo_update', 'issue_create', 'issue_close',
    'issue_claim', 'issue_comment', 'blockage_create', 'blockage_remove',
    'tm_create', 'tm_remove', 'bg_create',
    'bg_remove', 'mail_to', 'broadcast', 'git_commit',
  ]);

  // Read-only bash commands (exploration)
  const READ_ONLY_BASH = /^(ls|cat|pwd|head|tail|wc|find|which|git\s+(status|log|diff|branch|show|ls-files))/;

  // Track recent tool calls for repetition detection
  const recentToolCalls: string[] = [];

  // === Loop-level failure backoff + circuit breaker ===
  // When retryChat exhausts its 4× retries on a hung endpoint (e.g. Ollama
  // cloud wsarecv timeout), the error propagates here. Without this counter
  // the loop would wait a flat 1s and immediately retry the SAME iteration
  // against the same hung endpoint — another ~87s stuck cycle, repeating
  // until the network recovers. Instead: exponential backoff between loop
  // retries, and after MAX_CONSECUTIVE_FAILURES transition to idle (resumes
  // mail polling so the lead can intervene / the worker isn't "working" but
  // unreachable). Reset to 0 on any successful LLM turn.
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const MAX_LOOP_BACKOFF_MS = 10_000;

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
          triologue.note('SYSTEM', 'Plan mode has ended. Code changes are now allowed. All tools (write_file, edit_file, bash) are fully functional. Proceed with your tasks.');
        } else {
          triologue.note('SYSTEM', 'Plan mode is now active. Code changes are temporarily restricted. Continue with read-only operations while waiting.');
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
            `~${remaining}s left.${remaining < 30 ? ' Send mail_to with a new eta to extend.' : ''}`);
        }
      }

      // 5. Build system prompt and call LLM
      // Ensure we have a valid message sequence before calling LLM
      if (lastRole === 'assistant') {
        // Last message was assistant with no tool calls - need user message before next LLM call
        // This can happen after resuming from idle without new input
        triologue.note('REMINDER', 'Continue with your task.');
      }

      triologue.setSystemPrompt(buildNormalModePrompt(WORKDIR, { name: teammateName, role: teammateRole }));

      // Per-turn watchdog: abort the LLM call if it blocks past the turn
      // deadline so mail polling at the top of the loop can resume. Without
      // this a hung retryChat keeps status 'working' and starves the mail
      // poll indefinitely (the "stuck teammate" symptom).
      const watchdog = createTurnWatchdog();
      const turnStart = Date.now();
      let response;
      try {
        response = await retryChat(
          {
            model: MODEL,
            messages: triologue.getMessages(),
            tools,
          },
          { signal: watchdog.signal, noSpinner: true },
        );
      } catch (err) {
        watchdog.clearTimeout();
        if (err instanceof StreamAbortedError && watchdog.signal.aborted) {
          // Watchdog fired: report and let the loop continue (mail poll resumes).
          const elapsed = Date.now() - turnStart;
          reportStuckTurn('LLM turn watchdog', elapsed);
          triologue.note('SYSTEM',
            `Previous LLM turn was aborted by the stuck-teammate watchdog after ${Math.round(elapsed / 1000)}s ` +
            `(likely the LLM endpoint hung). No response was received. Continue your task; ` +
            `check mailbox for any new instructions from lead.`);
          continue;
        }
        // Non-watchdog error: rethrow into the outer try/catch (briefs + 1s pause + retry).
        throw err;
      }
      watchdog.clearTimeout();

      // LLM turn succeeded — reset the loop-level failure counter.
      consecutiveFailures = 0;

      const assistantMessage = response.message;
      const reasoningContent = (assistantMessage as unknown as Record<string, unknown>).reasoning_content as string | undefined;
      const toolCalls = assistantMessage.tool_calls as ToolCall[] | undefined;

      // Confusion scoring: +1 per assistant turn (agent spinning without progress)
      ctx.core.increaseConfusionIndex(1);

      // ---- No tools: re-prompt or enter idle ----
      if (!toolCalls || toolCalls.length === 0) {
        // Register the assistant message (no tool calls to track)
        triologue.agent(assistantMessage.content || '', undefined, reasoningContent);

        nextBriefNudge = 5;
        if (!budgetSent) {
          const exampleEta = Math.floor(Date.now() / 1000 + 120);
          triologue.note('REMINDER',
            `Request a time budget from lead via mail_to(name="lead", eta=${exampleEta}, ...).`);
        } else if (!ctx.todo.hasOpenTodo()) {
          // No open todos and LLM produced no tool calls — likely done
          // Auto-mail the assistant message to lead
          ctx.team.mailTo('lead', 'Teammate phase completed', assistantMessage.content || '');
          const result = await enterIdleState(triologue);
          if (result === 'shutdown') {
            process.exit(0);
          }
          // Resume work phase
          continue;
        } else {
          triologue.note('REMINDER', 'Use tools to make progress on the task.');
        }
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

          // === Auto-compact: check after each tool result (mirrors lead's tool.ts) ===
          // Without this, large write_file/edit_file outputs bloat the context
          // indefinitely until retryChat() fails and the worker stalls in a
          // retry loop (see session aecf9aea root cause).
          if (triologue.needsCompact()) {
            // Skip any remaining pending tools in this batch
            triologue.skipPendingTools(
              'Context limit reached. Remaining tool calls in this batch were skipped.',
              'Compacting conversation to continue.'
            );
            // Compact summarization is itself a retryChat — guard it with the
            // same turn watchdog so a hung summarization cannot block mail
            // polling. On watchdog abort we skip compact this round (context
            // stays over threshold; the next turn will retry compaction).
            const compactWatchdog = createTurnWatchdog();
            const compactStart = Date.now();
            try {
              await triologue.compact(undefined, compactWatchdog.signal);
            } catch (err) {
              if (err instanceof StreamAbortedError && compactWatchdog.signal.aborted) {
                const elapsed = Date.now() - compactStart;
                reportStuckTurn('compact summarization watchdog', elapsed);
                triologue.note('SYSTEM',
                  `Auto-compact summarization was aborted by the stuck-teammate watchdog after ${Math.round(elapsed / 1000)}s. ` +
                  `Context remains over the threshold; compaction will be retried next turn.`);
              } else {
                // Non-watchdog compact error: surface but don't crash the worker.
                ctx.core.brief('error', 'compact', `Compact failed: ${(err as Error).message}`);
                triologue.note('SYSTEM', `Auto-compact failed: ${(err as Error).message}. Continuing without compaction.`);
              }
            } finally {
              compactWatchdog.clearTimeout();
            }
            ctx.core.resetConfusionIndex();
            recentToolCalls.length = 0;
            break; // Exit the for-loop, let the while-loop continue
          }

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
          // Send guidance request to lead. NOTE: reaching the confusion
          // threshold means the teammate has done enough turns without a
          // strong progress signal that a check-in would help — it is NOT
          // necessarily blocked. The wording reflects that the teammate is
          // still working and is asking for direction/feedback, so the lead
          // doesn't mistake this for a hard blocker (which caused false
          // "stuck" alarms and premature teammate removals in the past).
          ctx.team.mailTo('lead', 'Guidance request',
            `Guidance request (confusion index: ${confusionIndex}). ` +
            `I'm working but could benefit from direction or feedback. ` +
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
      triologue.note('SYSTEM', `An error occurred: ${errorMsg}. Please continue with your task.`);

      consecutiveFailures++;

      // Circuit breaker: after MAX_CONSECUTIVE_FAILURES, enter idle to resume
      // mail polling. This prevents an endless stuck-cycling loop when the
      // LLM endpoint is down (each retryChat completes in ~87s < the 180s
      // watchdog cap, so the watchdog never fires and the loop just keeps
      // hammering the hung endpoint). Idling lets the lead's mail get
      // picked up and surfaces the problem instead of silent spinning.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        ctx.core.brief('warn', 'loop',
          `${consecutiveFailures} consecutive failures. Entering idle to resume mail polling.`);
        triologue.note('SYSTEM',
          `Experienced ${consecutiveFailures} consecutive network failures. ` +
          `Entering idle state to resume mail polling. Lead will be notified.`);
        try {
          ctx.team.mailTo('lead', `WARNING: ${teammateName} network failures`,
            `Teammate "${teammateName}" hit ${consecutiveFailures} consecutive LLM/network failures ` +
            `and is entering idle to resume mail polling. The endpoint may be down. ` +
            `Consider tm_remove or send mail with instructions.`);
        } catch {
          // best-effort
        }
        consecutiveFailures = 0; // reset on entering idle
        const result = await enterIdleState(triologue);
        if (result === 'shutdown') {
          process.exit(0);
        }
        // resumed from idle (new mail arrived) — continue the work loop
        continue;
      }

      // Exponential backoff: 1s, 2s, 4s, ... capped at MAX_LOOP_BACKOFF_MS.
      const backoffMs = Math.min(
        1000 * Math.pow(2, consecutiveFailures - 1),
        MAX_LOOP_BACKOFF_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
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
            triologue.note('SYSTEM', `Issue #${issue.id}: ${issue.title}\n${issue.content || ''}`);
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
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  teammateName = msg.name;
  teammateRole = msg.role;

  // Set working directory from spawn message (e.g., a worktree path) or fall back to process.cwd()
  if (msg.cwd) {
    WORKDIR = msg.cwd;
  }

  // Set session context before creating any mailboxes (fail-fast)
  if (msg.sessionId) {
    setSessionContext(msg.sessionId);
  }

  // Create child context
  ctx = new ChildContext(teammateName, WORKDIR);

  // Startup lifecycle logs are verbose-only (see note above).
  ctx.core.verbose('worker', `${teammateName} initializing...`);

  // Load tools and skills (silent mode - suppress loading logs)
  await silentLoader.loadAll();

  // Startup lifecycle logs are verbose-only: they fire on every teammate
  // spawn and would otherwise clutter the lead's terminal in normal mode.
  // (ChildCore.verbose() forwards an IPC 'verbose' notification that the
  // parent only prints when -v is set.)
  ctx.core.verbose('worker', `${teammateName} started successfully`);

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

// Log that worker is ready (before ctx is available, use sendNotification).
// Verbose-only: this fires on every teammate spawn and would otherwise clutter
// the lead's terminal in normal mode. We send an IPC 'verbose' notification
// (which the parent only prints under -v) gated by isVerbose() to avoid
// unnecessary IPC traffic in normal mode.
if (isVerbose()) {
  ipc.sendNotification('verbose', { tool: 'worker', message: 'Worker process started, waiting for spawn message' });
}

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