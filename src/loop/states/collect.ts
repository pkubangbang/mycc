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
import type { SequenceEvent } from '../../hook/sequence.js';
import { skillSuggester } from './collect-skill.js';
import { listWorktrees } from '../../context/worktree-store.js';
import { getServeHub } from '../../serve/serve-registry.js';
import { resolveHeadlessFirstQuery } from '../../session/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { loopEvents } from '../loop-events.js';

// Confusion threshold for hint generation
const CONFUSION_THRESHOLD = 10;
// Minimum message count before hint generation
const MIN_MESSAGES_FOR_HINT = 6;
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
 * Generate a human-readable breakdown of confusion factors
 */
function generateBreakdown(
  _confusionIndex: number,
  events: SequenceEvent[]
): string {
  const parts: string[] = [];

  // Count assistant turns (inferred from events - each turn has multiple tools)
  // Estimate turns by counting unique tool call batches
  const turnCount = Math.ceil(events.length / 3); // rough estimate
  if (turnCount > 0) {
    parts.push(`${turnCount} assistant turns`);
  }

  // Count errors — only match error/failed/fatal at the start of the result
  // to avoid false positives from normal file content containing these words.
  // Keep 'includes' for OS error codes (ENOENT, EACCES, EPERM) which are
  // specific identifiers that won't appear in file content.
  const errors = events.filter(e => {
    const result = e.result?.toLowerCase() || '';
    return result.startsWith('error:') || result.startsWith('error ') ||
           result.startsWith('fatal:') || result.startsWith('failed:') ||
           result.startsWith('failed ') ||
           result.includes('enoent') || result.includes('eacces') ||
           result.includes('eperm') || result.includes('permission denied');
  });
  if (errors.length > 0) {
    parts.push(`${errors.length} tool errors`);
  }

  // Dead-loop evidence: same tool called 3+ times recently with the same error
  // prefix. Feeds the hint-round prompt instruction 8 so the LLM judges
  // should_compact on facts (a repeated-action line) rather than a vague
  // "the conversation feels long" feeling, which was over-triggering compact.
  const repeated = detectRepeatedActions(events);
  if (repeated) {
    parts.push(repeated);
  }

  return parts.length > 0 ? parts.join(', ') : 'No issues detected';
}

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
 * Detect repeated tool actions that signal a dead-loop, to feed the hint
 * round as objective evidence (so the LLM judges should_compact on facts,
 * not on a vague "the conversation feels long" feeling).
 *
 * A "repeated action" = the same tool called 3+ times in the recent window
 * with results that share the same error-ish prefix. We look at the trailing
 * events (the recent window) and group consecutive same-tool calls; if 3+
 * share a common error prefix, we report it. Bash is keyed by its first
 * command clause (so repeated `pnpm test` runs group together even when the
 * tail differs); other tools are keyed by a stable arg (path/name/command).
 *
 * Returns a human-readable line like:
 *   "Repeated actions: edit_file ×4 (results start with "Error: old_text not found")"
 * or null if no repetition is found. The hint-round prompt (instruction 8)
 * tells the LLM to default should_compact=false when there is no such line.
 *
 * Exported for unit testing (see src/tests/loop/states/collect-repeated.test.ts).
 */
export function detectRepeatedActions(events: SequenceEvent[]): string | null {
  if (events.length < 3) return null;
  // Inspect only the trailing window — a dead-loop is a RECENT phenomenon.
  const window = events.slice(-8);
  // Group consecutive same-tool calls; report the largest group with 3+ that
  // also share an error prefix in their results.
  const groups: Array<{ tool: string; events: SequenceEvent[] }> = [];
  for (const ev of window) {
    const last = groups[groups.length - 1];
    if (last && last.tool === ev.tool) {
      last.events.push(ev);
    } else {
      groups.push({ tool: ev.tool, events: [ev] });
    }
  }
  let best: { tool: string; count: number; prefix: string } | null = null;
  for (const g of groups) {
    if (g.events.length < 3) continue;
    const prefix = commonErrorPrefix(g.events.map(e => e.result || ''));
    if (prefix) {
      const candidate = { tool: g.tool, count: g.events.length, prefix };
      if (!best || candidate.count > best.count) best = candidate;
    }
  }
  if (!best) return null;
  return `Repeated actions: ${best.tool} ×${best.count} (results start with "${best.prefix}")`;
}

/**
 * Find the longest common error prefix across results that look like errors.
 * Only considers results that start with an error-ish marker; if fewer than
 * 3 share a prefix, returns null (not a dead-loop signal).
 */
function commonErrorPrefix(results: string[]): string | null {
  const errorish = results.filter(r => {
    const lower = r.toLowerCase();
    return lower.startsWith('error:') || lower.startsWith('error ') ||
      lower.startsWith('failed') || lower.includes('not found') ||
      lower.includes('no such') || lower.includes('does not match');
  });
  if (errorish.length < 3) return null;
  // Longest common prefix of the first 40 chars (enough to identify the
  // repeated error class without dumping a whole message into the breakdown).
  const snippets = errorish.map(r => r.slice(0, 40));
  let prefix = snippets[0];
  for (const s of snippets) {
    while (prefix && !s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) break;
  }
  return prefix && prefix.length >= 6 ? prefix : null;
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

/** Signal returned by runHintRound to steer the orchestrator. */
type HintSignal = 'continue' | 'stop' | 'collect';

/**
 * Step 3: generate a hint round when confusion is high, and handle its
 * three outcomes.
 *
 * @returns `'stop'` if ESC aborted the hint round (caller returns STOP for
 *          centralized wrap-up); `'collect'` if the hint round signalled a
 *          dead-loop compaction (caller returns COLLECT to continue on
 *          compacted context); `'continue'` for a normal pass (or when the
 *          hint block was skipped).
 *
 * Side effects on `turn`: captures `lastHintFocus` (the hint source) on a
 * successful hint round; clears `collectTransientRetries` on compaction.
 */
async function runHintRound(env: MachineEnv, turn: TurnVars): Promise<HintSignal> {
  const { triologue, ctx } = env;
  const confusionIndex = ctx.core.getConfusionIndex();
  const messageCount = triologue.getMessagesRaw().length;

  if (confusionIndex < CONFUSION_THRESHOLD || messageCount < MIN_MESSAGES_FOR_HINT) {
    return 'continue';
  }

  // Use brief for hint round notification (user-facing)
  ctx.core.brief('info', 'loop', 'Generating hint...');
  const pendingSkills = env.conditions.getPending();
  const breakdown = generateBreakdown(confusionIndex, env.sequence.getEvents());

  // Use escAware for ESC-interruptible hint generation
  const result = await ctx.core.escAware(
    async (abortController) => {
      return await triologue.generateHintRound(abortController, confusionIndex, breakdown, pendingSkills);
    },
    () => {
      // ESC pressed during hint generation — return 'aborted' so the
      // caller returns STOP for centralized wrap-up (stop.ts handles
      // startWrapUp + auto-off + setNeglectedMode).
      return 'aborted' as const;
    }
  );

  // If aborted (ESC pressed), return STOP for centralized wrap-up.
  // Neglected mode is NOT cleared here — stop.ts handles that.
  if (result === 'aborted') {
    return 'stop';
  }
  // Capture focus_on from a successful hint round (hint source for the
  // composite keyword extraction below). The discriminated union
  // carries focusOn only on the success path.
  if (result !== 'compact' && result.status === 'success') {
    turn.lastHintFocus = result.focusOn;
  }
  // If the LLM signalled should_compact (dead-loop or context stress),
  // trigger compaction now and CONTINUE the loop on fresh, compacted
  // context. Compaction is a mid-turn intervention (not a turn boundary),
  // so we return COLLECT (not STOP): COLLECT → LLM will retryChat on the
  // now-compacted triologue within the same turn. Returning STOP here was
  // the bug — STOP → PROMPT ends the turn and waits for user input, so the
  // loop stalled at PROMPT after a hint-compact. This mirrors the
  // hook-deferred compaction path (hook.ts sets deferredCompact → llm.ts
  // compacts and continues the while-loop).
  //
  // TP parity: compact() replaces the conversation with a 3-message
  // [summary_user, brief_assistant, brief_tool] resume sequence, so
  // getLastRole() is 'tool' — the next agent() (the real LLM response) is a
  // natural tool→assistant transition. Any note/user/tool the following
  // states inject starts from a legal role sequence. No special TP handling
  // needed here.
  //
  // Stat reset MUST mirror the llm.ts auto-compact branch: the stale
  // sequence events, embedding tracker, hook dedup cap, and crossroad
  // cooldown were all computed against the pre-compact history that no
  // longer exists. Without these resets, the continued loop would run on
  // corrupted stats (e.g. sequence events inflating the next confusion
  // score, hook dedup cap suppressing the next turn's hooks).
  if (result === 'compact') {
    ctx.core.brief('info', 'loop', 'Hint round signalled compaction (dead-loop / context stress); compacting...');
    const tools = loader.getToolsForScope(env.scope);
    await triologue.compact(undefined, undefined, tools);
    ctx.core.resetConfusionIndex();
    env.requestEmbeddingTracker.clear();
    // compactReset() clears session-level data ONLY (turn.events[] and
    // totalTurns survive — a turn spans across compaction). resetTurn()
    // re-arms per-turn hook dedup (same rationale as llm.ts auto-compact).
    env.sequence.compactReset();
    env.hookExecutor.resetTurn();
    env.crossroadOccurred = false;
    // Turn recovered via compaction — clear the transient-retry counter
    // so the next hiccup starts a fresh circuit-breaker count.
    turn.collectTransientRetries = 0;
    return 'collect';
  }
  // Reset confusion after hint
  ctx.core.resetConfusionIndex();
  return 'continue';
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
    const hintSignal = await runHintRound(env, turn);
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
