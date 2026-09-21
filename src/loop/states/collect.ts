/**
 * collect.ts - COLLECT state handler
 *
 * Pre-LLM pipeline: child questions, mail collection,
 * hint round, todo nudging, brief nudging,
 * role sequence validation.
 */

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { autoState } from '../auto-state.js';
import { isVerbose } from '../../config.js';
import { loader } from '../../context/shared/loader.js';
import { forkChat } from '../../engine/chat-provider.js';
import { isTransientError } from '../../engine/chat-helpers.js';
import { hintSuggester } from './collect-hint.js';
import { skillSuggester } from './collect-skill.js';
import { listWorktrees } from '../../context/worktree-store.js';
import { getServeHub } from '../../serve/serve-registry.js';
import { resolveHeadlessFirstQuery } from '../../session/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { loopEvents } from '../loop-events.js';

/**
 * Max consecutive transient COLLECT errors retried within one turn before the
 * circuit breaker trips and the turn is abandoned to PROMPT (interactive) /
 * AWAIT (auto). Without this cap, a truly-down endpoint would spin
 * COLLECT→transient-error→COLLECT forever in auto mode (the recovery path
 * returns COLLECT to retry the turn). Each retryChat already does 4 internal
 * attempts with backoff, so one COLLECT transient failure ≈ 4 failed LLM
 * POSTs; 3 turns ≈ 12 attempts — enough to ride out a brief cloud hiccup
 * while still terminating a sustained outage. Mirrors llm.ts MAX_EMPTY_RETRIES
 * (3) in spirit: a bounded retry-then-bail backstop.
 */
const MAX_COLLECT_TRANSIENT_RETRIES = 3;

/**
 * Shape of a single reactivation evaluation returned by the LLM via forkChat.
 */
interface ReactivationEvaluation {
  id: number;
  hash: string;
  reopen: boolean;
  reason?: string;
}

/**
 * Parse the forkChat result into a list of reactivation evaluations.
 *
 * Tolerant parsing: tries a direct `JSON.parse` first; on failure, attempts to
 * regex-extract the first `[...]` JSON array and retry; on any failure or
 * non-array shape, returns null (caller skips this turn).
 *
 * Exported for unit testing (see src/tests/loop/states/collect-reactivation.test.ts).
 */
export function parseReactivationResult(raw: string): ReactivationEvaluation[] | null {
  const trimmed = raw.trim();
  // 1. Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as ReactivationEvaluation[];
    return null;
  } catch {
    // fall through to extraction
  }
  // 2. Extract first JSON array from surrounding noise
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed as ReactivationEvaluation[];
  } catch {
    // give up
  }
  return null;
}

/**
 * Evaluate completed pinned todos carrying a reactivation condition and reopen
 * those whose condition is met. Runs in the COLLECT state, immediately before
 * the todo nudge, on the same throttle cycle (so the nudge prints the
 * already-updated list — no "closed then reopened" contradiction).
 *
 * Uses `forkChat` with `toolChoice: 'none'` to preserve the prompt cache and
 * ask the LLM to return a JSON array. Every failure path is silent
 * (verbose-only) and never blocks the agent loop:
 *  - no candidates → no forkChat call
 *  - forkChat throws → catch, skip this turn
 *  - non-JSON / non-array result → skip this turn
 *  - per-entry: wrong types, hash mismatch (hallucination), reopen=false → skip entry
 */
async function checkReactivation(env: MachineEnv): Promise<void> {
  const { triologue, ctx } = env;
  const candidates = ctx.todo.getReactivationCandidates();
  if (candidates.length === 0) return;

  // Build the evaluation prompt. `id` is fixed (echoed back); `hash` is
  // supplied by the LLM from the conversation context so the anti-hallusion
  // check stays active — a fabricated hash won't match the candidate.
  const todoLines = candidates.map(
    (c) => `#${c.id} "${c.name}" — Condition: "${c.reactivate}"`,
  );
  const prompt =
    'You are evaluating whether any pinned todos should be reactivated (marked back to not done).\n\n' +
    `Pinned todos to evaluate:\n${todoLines.join('\n')}\n\n` +
    'Based on the conversation context above, for EACH todo, determine if its reactivation condition has been met.\n\n' +
    'Reply with ONLY a JSON array, no other text. Schema:\n' +
    '[\n' +
    '  {"id": <todo_id>, "hash": "<current_hash_of_this_todo>", "reopen": <true|false>, "reason": "<one sentence>"}\n' +
    ']\n\n' +
    'Rules:\n' +
    '- "id": the todo ID as listed above (echo it back).\n' +
    '- "hash": the current hash of this todo item (from the todo list you have seen in conversation).\n' +
    '- "reopen": true only if the condition has clearly been met in the recent conversation.\n' +
    '- If no relevant event has occurred, or you are unsure, use false.\n' +
    '- Do not reactivate based on events that happened before the todo was last completed.';

  const fullMessages = triologue.getMessages();
  const allTools = loader.getToolsForScope(env.scope);

  let result: string;
  try {
    // Wrap in escAware so ESC (WebUI "停止" button / terminal ESC) aborts the
    // forkChat immediately. Without this, a slow endpoint keeps the state
    // machine stuck in COLLECT for the full call duration, and every
    // subsequent click is a no-op (triggerNeglection() guards with
    // isNeglectedMode()). On ESC, return '' so parseReactivationResult()
    // yields null → function returns early → COLLECT routes to STOP.
    result = await ctx.core.escAware(
      async (abortController) => {
        return await forkChat(fullMessages, allTools, prompt, abortController.signal, 'none');
      },
      () => '' as const,
    );
  } catch (err) {
    ctx.core.verbose('reactivate', `forkChat failed: ${(err as Error).message}, skipping reactivation this turn`);
    return;
  }

  const evaluations = parseReactivationResult(result);
  if (!evaluations) {
    ctx.core.verbose('reactivate', 'forkChat returned non-JSON or non-array, skipping reactivation this turn');
    return;
  }

  for (const ev of evaluations) {
    // Per-entry type guards — skip malformed entries, keep going
    if (typeof ev.id !== 'number' || typeof ev.hash !== 'string' || typeof ev.reopen !== 'boolean') {
      continue;
    }
    if (!ev.reopen) continue;

    // Hash anti-hallusion: match by id AND hash. A hallucinated hash won't
    // match and the entry is silently skipped.
    const candidate = candidates.find((c) => c.id === ev.id && c.hash === ev.hash);
    if (!candidate) continue;

    // Reopen directly — the LLM does not decide; the system acts.
    const updated = ctx.todo.updateTodo(
      candidate.id,
      candidate.hash,
      candidate.name,
      false,
      candidate.note,
    );
    if (updated) {
      triologue.note(
        'SYSTEM',
        `Pinned todo #${candidate.id} "${candidate.name}" reactivated. ` +
          `Condition "${candidate.reactivate}" was met.${ev.reason ? ` ${ev.reason}` : ''}`,
      );
    }
  }
}

/**
 * Steps 1–2: drain all external inputs into the triologue.
 *
 * Collects (in order): pending child questions, mails, team-status overview,
 * steering notes (webui-only), the headless first-query marker, and uploaded
 * files (webui-only). Each is injected as a triologue note (MAIL / URGENT /
 * SYSTEM / REMINDER) relying on auto-fix for TP-safe injection.
 *
 * @returns the freshest steering note drained this pass (`firstSteerNote`),
 *          or null if none. This is the query source for
 *          skillSuggester.runKeywordExtraction (step 6) — steering notes take
 *          priority over lastUserQuery as the freshest mid-task direction.
 */
async function collectMailsAndInput(env: MachineEnv): Promise<{ firstSteerNote: string | null }> {
  const { triologue, ctx } = env;

  // 1. Handle pending questions from children
  await ctx.team.handlePendingQuestions();

  // 2. Collect mails — relies on auto-fix for TP-safe injection
  //    The MAIL note carries pure mail content only. Reply guidance (who to
  //    contact and how) lives in the todo/peer-channels nudge below, not
  //    here — keeping each note lightweight. The sender's identity is in
  //    `mail.from` (a teammate name, or a peer identity "<session-id>/lead"),
  //    which the mail_to tool accepts as its `name` argument; the nudge tells
  //    the agent that.
  const mails = ctx.mail.collectMails();
  if (mails.length > 0) {
    const parts: string[] = [];
    for (const mail of mails) {
      parts.push(`Mail from ${mail.from}: ${mail.title}\n${mail.content}`);
    }
    const mailContent = parts.join('\n\n---\n\n');
    if (agentIO.isNeglectedMode()) {
      triologue.note('URGENT', `user interrupted - wrap up quickly\n${mailContent}`);
    } else {
      triologue.note('MAIL', mailContent);
    }
  }

  // 2b. Inject team status overview so lead sees deadlines without calling tm_print
  const teamStatus = await ctx.team.printTeam();
  if (teamStatus !== 'No teammates.') {
    triologue.note('SYSTEM', teamStatus);
  }

  // 2c. Drain steering queue (webui-only): if serve is running, consume any
  //     steering notes the user queued during this run and inject them as a
  //     REMINDER note. Unlike the PROMPT synthesis path (which merges stale
  //     notes with a fresh query after an interrupt), this is the in-flight
  //     path: the LLM reached COLLECT mid-run with notes still queued, so
  //     they are current direction for the ongoing work and injected as-is.
  //     Reuses the REMINDER NoteCategory — no new category needed.
  let firstSteerNote: string | null = null;
  if (getServeHub().isRunning()) {
    const steerNotes = getServeHub().drainSteering();
    if (steerNotes.length > 0) {
      const steerContent = steerNotes.map((n, i) => `(${i + 1}) ${n}`).join('\n');
      triologue.note('REMINDER', `Steering notes from the user (mid-task direction):\n${steerContent}`);
      agentIO.verbose('steer', `Drained ${steerNotes.length} steering note(s) at COLLECT`);
      // Mid-task user direction is a user intervention — reset the autofly
      // streak so the LLM stages that follow aren't counted as "consecutive
      // successful since last user input". An empty drain (no notes) is NOT
      // user input, so the reset stays inside this guard.
      autoState.resetStreak();
      firstSteerNote = steerNotes[0];
    }
  }

  // 2d. Headless first_query marker reset: a session that bootstrapped into
  //     auto mode (--auto / --daemon) carries the HEADLESS_FIRST_QUERY_MARKER
  //     in first_query (see markHeadlessSession). The first real wake event
  //     processed HERE is that session's actual first query — mail covers a
  //     channel first-query (delivered to the local mailbox), peer mail, and
  //     cron nudges; a steering note covers a webui/user hint; a teammate
  //     question lands as the Q&A mail appended by handlePendingQuestions()
  //     in step 1, so it is collected by the same collectMails() above.
  //     resolveHeadlessFirstQuery no-ops unless the value is still exactly
  //     the marker, so later events never overwrite a real first query.
  //     (A marker left by a user who ESC-ed out of a fresh --auto session
  //     and typed interactively is resolved by the PROMPT bookmark capture
  //     in prompt.ts — see the HEADLESS_FIRST_QUERY_MARKER branch there.)
  const firstEvent = mails.length > 0
    ? `Mail from ${mails[0].from}: ${mails[0].title}\n${mails[0].content}`
    : firstSteerNote;
  if (firstEvent) {
    resolveHeadlessFirstQuery(env.sessionFilePath, firstEvent);
  }

  // 2e. Drain file upload queue (webui-only): if serve is running, save any
  //     uploaded files to ./.mycc/uploaded/ and mention them via a REMINDER
  //     note so the LLM can reference them (e.g. via read_picture).
  if (getServeHub().isRunning()) {
    const files = getServeHub().drainFileUploads();
    if (files.length > 0) {
      const uploadDir = path.join(process.cwd(), '.mycc', 'uploaded');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const fileInfos: string[] = [];
      for (const file of files) {
        const safeName = `${Date.now()}_${file.filename}`;
        const filePath = path.join(uploadDir, safeName);
        fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
        const relPath = path.relative(process.cwd(), filePath);
        fileInfos.push(`- ${file.filename} → ${relPath} (${file.mimeType})${file.text ? `\n  Text: "${file.text.slice(0, 200)}${file.text.length > 200 ? '...' : ''}"` : ''}`);
      }
      triologue.note('REMINDER', `User uploaded file(s):\n${fileInfos.join('\n')}`);
      agentIO.verbose('serve', `Saved ${files.length} uploaded file(s) to ${uploadDir}`);
    }
  }

  return { firstSteerNote };
}

/**
 * Step 4: todo + peer-channel nudging with state tracking.
 *
 * The guard fires when there are open todos OR an active peer channel (a
 * joined channel with a fresh peer). Channel state is appended to the same
 * nudge so the LLM sees peer context without a separate mechanism (keeps
 * todo.ts pure — channel info comes from ctx.peer). When the throttle
 * counter hits 0, reactivation runs FIRST (so the nudge prints the
 * already-updated list — no "closed then reopened" flicker), then the
 * nudge is injected.
 *
 * Side effects on `turn`: `nextTodoNudge` (decremented / reset) and
 * `lastTodoState` (dedup cursor for the nudge).
 */
async function runTodoNudge(env: MachineEnv, turn: TurnVars): Promise<void> {
  const { triologue, ctx } = env;
  const activeChannels = ctx.peer.listChannels().filter(
    ch => ch.joined && ch.peerSessionId && ctx.peer.isFresh(ch.peerSessionId)
  );
  // Look up each peer's workDir from the identity registry (ChannelFile does
  // not carry workDir; it lives on IdentityEntry). Falls back to '?' if the
  // peer unregistered between listChannels() and now (shouldn't happen for a
  // fresh peer, but be defensive).
  const peerWorkDirs = new Map<string, string>();
  for (const id of ctx.peer.listIdentities()) {
    peerWorkDirs.set(id.sessionId, id.workDir);
  }
  const channelLine = (ch: typeof activeChannels[number]): string => {
    const workDir = peerWorkDirs.get(ch.peerSessionId!) ?? '?';
    // `topic` is the channel's static `title` theme; mail_to routes a peer
    // reply by name="<peerSessionId>/lead". The `title=` value convention is
    // "<topic>:<subject>" so the recipient sees which channel the reply is on.
    return `- peer=${ch.peerSessionId}\n` +
      `  workdir=${workDir}\n` +
      `  channel=${ch.channelId}, topic=${ch.title ?? '(none)'}\n` +
      `  use mail_to(name="${ch.peerSessionId}/lead", title="${ch.title ?? ''}:<subject>") to communicate`;
  };
  if (ctx.todo.hasOpenTodo() || activeChannels.length > 0) {
    const currentTodoState = ctx.todo.printTodoList();
    const channelState = activeChannels.length > 0
      ? activeChannels.map(ch => `  [channel ${ch.channelId}] peer=${ch.peerSessionId} fresh=${ctx.peer.isFresh(ch.peerSessionId!)} title="${ch.title}"`).join('\n')
      : '';
    const compositeState = `${currentTodoState}\n${channelState}`;
    if (compositeState !== turn.lastTodoState) {
      turn.nextTodoNudge = 3;
      turn.lastTodoState = compositeState;
    }
    turn.nextTodoNudge--;
    if (turn.nextTodoNudge === 0) {
      // (4a) Reactivation FIRST — reopen pinned todos whose condition is met.
      await checkReactivation(env);
      // (4b) Nudge SECOND — prints the now-up-to-date todo list + channels.
      const nudgeParts = [`Update your todos. ${ctx.todo.printTodoList()}`];
      if (activeChannels.length > 0) {
        nudgeParts.push(`Active channels:\n${activeChannels.map(channelLine).join('\n\n')}`);
      }
      triologue.note('REMINDER', nudgeParts.join('\n'));
      turn.nextTodoNudge = 3;
    }
  }
}

/**
 * Steps 5 + 5b: brief nudging and worktree cleanup nudging.
 *
 * Side effects on `turn`: `nextBriefNudge` (decremented / reset to 5).
 * Side effects on `env`: `nextWtNudge` (the worktree check sentinel).
 */
async function runBriefAndWorktreeNudges(env: MachineEnv, turn: TurnVars): Promise<void> {
  const { triologue } = env;

  // 5. Brief nudging - remind agent to use brief tool
  turn.nextBriefNudge--;
  if (turn.nextBriefNudge <= 0) {
    triologue.note('REMINDER', 'Provide a brief status update using the brief tool. Example: brief("Working on X", 7)');
    turn.nextBriefNudge = 5;
  }

  // 5b. Worktree cleanup nudge.
  //     nextWtNudge == 0 is the "check now" sentinel: cheaply call
  //     listWorktrees() (async git query) each chat. If worktrees exist,
  //     inject a REMINDER and arm the counter to N so we don't nag every
  //     turn. If none, leave the counter at 0 (re-checkes next pass).
  //     When the counter is nonzero, just decrement it.
  if (env.nextWtNudge === 0) {
    const worktrees = await listWorktrees(process.cwd());
    if (worktrees.length > 0) {
      const lines = worktrees.map(w => `- ${w.name} at ${w.path} (branch: ${w.branch})`);
      triologue.note(
        'REMINDER',
        `Stale worktrees detected. Consider cleaning them up with bash (git worktree remove <path>) once the work is merged:\n${lines.join('\n')}`
      );
      env.nextWtNudge = 5;
    }
  } else {
    env.nextWtNudge--;
  }
}

/**
 * Step 7: log message count and token consumption in verbose mode.
 */
function logVerboseStats(env: MachineEnv, messageCount: number): void {
  if (!isVerbose()) return;
  const { triologue, ctx } = env;
  const tokenCount = triologue.getTokenCount();
  const tokenThreshold = triologue.getTokenThreshold();
  const utilization = ((tokenCount / tokenThreshold) * 100).toFixed(1);
  ctx.core.verbose('collect', `${messageCount} messages, ${tokenCount}/${tokenThreshold} tokens (${utilization}%)`);
}

export async function handleCollect(
  env: MachineEnv,
  turn: TurnVars,
  _chat: ChatData,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  try {
    // Observability: emit confusion_score at COLLECT entry (silent when no listeners)
    const confusionScoreEntry = ctx.core.getConfusionIndex();
    if (confusionScoreEntry > 0) {
      loopEvents.emit('confusion_score', { score: confusionScoreEntry });
    }

    // 1–2. Drain all external inputs (child questions, mail, team status,
    //      steering notes, headless first-query marker, file uploads).
    //      Returns the freshest steering note (the query source for step 6).
    const { firstSteerNote } = await collectMailsAndInput(env);

    // 3. Hint round + compaction. May short-circuit the pass.
    const hintSignal = await hintSuggester.runHintRound(env, turn);
    if (hintSignal === 'stop') return AgentState.STOP;
    if (hintSignal === 'collect') return AgentState.COLLECT;

    // 4. Todo + peer-channel nudging (with reactivation on the same cycle).
    await runTodoNudge(env, turn);

    // 5. Brief + worktree cleanup nudges.
    await runBriefAndWorktreeNudges(env, turn);

    // 6. Composite keyword extraction for proactive skill discovery.
    await skillSuggester.runKeywordExtraction(env, turn, firstSteerNote);

    // 7. Verbose token/message logging.
    const messageCount = triologue.getMessagesRaw().length;
    logVerboseStats(env, messageCount);

    // COLLECT passed cleanly — clear the transient-retry circuit breaker so
    // the next hiccup (possibly many turns later) starts a fresh count.
    turn.collectTransientRetries = 0;
    return AgentState.LLM;
  } catch (err) {
    // Defensive: log as much context as possible for this intermittent error.
    // The classic "Cannot read properties of undefined (reading 'role'/content')"
    // surfaced in COLLECT comes from holes in triologue.messages read by
    // unguarded raw consumers (hint-round, minifier). getMessagesRaw() now
    // filters holes, but if a new throw path emerges we want the stack and
    // the array shape to debug it instead of just the bare error message.
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error && err.stack ? err.stack : '';
    const rawLen = triologue.getMessagesRaw().length;
    const tokLen = triologue.getTokenCount();
    ctx.core.brief(
      'error',
      'collect',
      `COLLECT state error: ${errorMessage}`,
      `messages(raw)=${rawLen} tokens=${tokLen}\n${errorStack}`,
    );

    // If the user interrupted (neglected mode), route to STOP for centralized
    // wrap-up instead of dropping into PROMPT (which would prompt mid-
    // interruption). Mirrors the HOOK catch's neglected-mode guard.
    if (agentIO.isNeglectedMode()) {
      return AgentState.STOP;
    }

    // ── Transient-error recovery (mirrors the LLM state's catch) ──
    // A transient network error (e.g. "net/http: TLS handshake timeout" from
    // the Ollama cloud endpoint during hint-round generation) is recoverable.
    // retryChat already retried 4× with backoff internally; if it STILL
    // failed, the endpoint is briefly unreachable. Previously this catch
    // unconditionally returned PROMPT — which in auto/daemon mode routes to
    // AWAIT, BLOCKING forever for an external event (mail/teammate/steering)
    // that may never arrive. A headless daemon would thus stall silently on a
    // transient cloud hiccup with no way to self-recover.
    //
    // Fix: for transient errors, ask inputProvider.promptRetry whether to
    // retry the turn. In auto mode promptRetry ALWAYS returns true (it has an
    // `if (agentIO.getAuto()) return true;` guard — autonomous operation must
    // never block on a user) → we return COLLECT to re-enter the turn, which
    // regenerates the hint round (confusionIndex is still ≥ threshold since
    // the failure was before resetConfusionIndex). In interactive mode the
    // user is asked "Retry? [Y/n]" just like the LLM state does.
    //
    // Circuit breaker: a per-turn counter (turn.collectTransientRetries,
    // reset to 0 on any clean COLLECT pass) caps consecutive retries at
    // MAX_COLLECT_TRANSIENT_RETRIES so a truly-down endpoint cannot spin
    // COLLECT→error→COLLECT forever. When the cap is hit, or the user
    // declines the retry, fall back to PROMPT (the original behavior).
    if (isTransientError(err)) {
      if (turn.collectTransientRetries < MAX_COLLECT_TRANSIENT_RETRIES) {
        const shouldRetry = await env.inputProvider.promptRetry(errorMessage);
        if (shouldRetry) {
          turn.collectTransientRetries++;
          agentIO.verbose('collect',
            `Transient COLLECT error, retrying turn (${turn.collectTransientRetries}/${MAX_COLLECT_TRANSIENT_RETRIES}): ${errorMessage}`);
          return AgentState.COLLECT;
        }
      } else {
        agentIO.verbose('collect',
          `Transient COLLECT error, circuit breaker tripped after ${MAX_COLLECT_TRANSIENT_RETRIES} retries: ${errorMessage}`);
      }
    }

    return AgentState.PROMPT;
  }
}
