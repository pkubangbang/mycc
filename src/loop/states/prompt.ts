/**
 * prompt.ts - PROMPT state handler
 *
 * Entry point for each conversational turn. Handles:
 * - User input via InputProvider (or autonomous skip)
 * - Restored session initial query (first turn only)
 * - Pending slash query (from /load)
 * - Multi-line input (trailing backslash or Chinese enumeration comma)
 * - Exit commands (q/exit/quit)
 * - Bang commands (!)
 * - Slash command routing (→ SLASH)
 * - Adding query to triologue
 * - Bookmark title capture
 *
 * Quick-return ESC behavior:
 * - Check if wrap-up completed and determine append/discard based on timing
 * - If user submits after 3s grace period, append wrap-up to triologue
 * - If user submits before or within grace period, discard wrap-up
 */

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { openMultilineEditor } from '../../utils/multiline-input.js';
import { resolveHeadlessFirstQuery } from '../../session/index.js';
import { setSlashQuery } from './slash.js';
import { evaluateWrapUp, clearWrapUp } from '../esc-wrap-up.js';
import { extractKeywords } from '../keyword-extractor.js';
import { isDebuggingPrompt, isDebugAutofly } from '../../config.js';
import { forkChat } from '../../engine/chat-provider.js';
import type { RetryConfig } from '../../engine/chat-helpers.js';
import { getServeHub } from '../../serve/serve-registry.js';
import { agentIO, PromptAbortError } from '../agent-io.js';
import { autoState } from '../auto-state.js';

/**
 * Tighter retry config for steering synthesis. The synthesized query is a
 * short text-only merge of stale steering notes + a fresh user query, so the
 * generous defaults would cause unacceptable delays on network hiccups.
 */
const SYNTHESIS_RETRY_CONFIG: Partial<RetryConfig> = {
  firstTokenTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  maxRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 3_000,
};

/**
 * Synthesize stale steering notes with a fresh user query via forkChat.
 *
 * Used when the user interrupted the LLM with ESC and then submitted a new
 * query: any steering notes they queued during the previous run are now
 * stale (the run they were steering is gone), but they may still carry
 * informational value. Rather than discarding them or injecting stale
 * actionable intent, we ask the LLM to merge the steering notes into a
 * combined prompt that preserves the informational value while removing
 * stale direction.
 *
 * The synthesized text REPLACES the raw fresh query as the user message.
 * Steering notes are drained (consumed) after synthesis.
 *
 * @param messages - Current triologue messages (caller's copy before mutation)
 * @param tools - All available tools (for prompt cache preservation)
 * @param freshQuery - The fresh user query submitted after the interrupt
 * @param steeringNotes - Stale steering notes queued during the prior run
 * @returns Synthesized prompt, or the raw freshQuery if synthesis fails
 */
async function synthesizeWithSteering(
  messages: Parameters<typeof forkChat>[0],
  tools: Parameters<typeof forkChat>[1],
  freshQuery: string,
  steeringNotes: string[],
  signal?: AbortSignal,
): Promise<string> {
  const notesBlock = steeringNotes.map((n, i) => `(${i + 1}) ${n}`).join('\n');
  const synthesisPrompt = `While you were working, the user queued the following steering notes (mid-task direction). The work they were steering has been interrupted, so these notes may be stale as actionable direction, but they may still carry informational value. Your latest fresh query is also given below.

Queued steering notes:
"""
${notesBlock}
"""

Fresh user query:
"""
${freshQuery}
"""

Synthesize a single combined user prompt that:
1. Preserves the informational value of the steering notes (context, constraints, references, facts).
2. Drops any stale actionable direction that no longer applies after the interrupt.
3. Integrates the fresh user query as the primary intent.
4. Is written in the user's voice, as a natural instruction — NOT a meta-description of the merge.

Output ONLY the synthesized user prompt — no preamble, no sign-off, no quotes.`;

  try {
    const synthesized = await forkChat(
      messages,
      tools,
      synthesisPrompt,
      signal,
      'none',
      SYNTHESIS_RETRY_CONFIG,
    );
    const clean = synthesized.trim();
    if (clean.length === 0) {
      agentIO.verbose('steer', 'Synthesis returned empty text; using raw fresh query');
      return freshQuery;
    }
    agentIO.verbose('steer', `Synthesized query: ${clean.slice(0, 120)}${clean.length > 120 ? '...' : ''}`);
    return clean;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    agentIO.verbose('steer', `Synthesis failed (${msg}); using raw fresh query`);
    return freshQuery;
  }
}

/** Captured once per machine lifetime */
let bookmarkCaptured = false;

/** Restored session initial query (consumed on first prompt) */
let initialQuery: string | null = null;

export function setInitialQuery(query: string | null): void {
  initialQuery = query;
}

export async function handlePrompt(
  env: MachineEnv,
  turn: TurnVars,
  _chat: ChatData,
): Promise<HandlerResult> {
  const { triologue, inputProvider, sessionFilePath } = env;
  const { ctx } = env;

  // ── Auto-mode engagement gate ──
  // PROMPT is the single decision point for whether the loop should skip
  // prompting the user and run autonomously. Two conditions, checked in
  // order, redirect to WAIT instead of asking for input:
  //
  //   1. Auto mode is already on (e.g. engaged via /auto or a prior autofly
  //      trigger). Just jump to WAIT — the loop keeps running.
  //
  //   2. Auto mode is off, but one of the autofly triggers is armed AND the
  //      streak of consecutive successful LLM stages exceeds the threshold N.
  //      Triggers: the immutable --debug-autofly CLI flag, OR an active peer
  //      channel (a joined channel with a fresh peer — see hasActiveChannel()).
  //      Having an active channel is equivalent to --debug-autofly: it engages
  //      auto mode now (setAuto(true)) so subsequent PROMPT entries take path 1,
  //      then jumps to WAIT. ESC gives the user N turns (default 3) before the
  //      streak re-arms and auto re-engages.
  //
  // The threshold lives in the AutoState singleton — agent-repl seeds it once
  // at startup from --autofly=N (falling back to the built-in default), so
  // PROMPT reads a single source of truth instead of re-parsing the CLI arg.
  //
  // If neither condition holds, fall through to normal prompting. Plan/normal
  // mode is untouched by this gate (auto is orthogonal to plan/normal).
  if (autoState.getAuto()) {
    autoState.setAuto(true); // idempotent re-sync (no-op, keeps onAutoChange calm)
    return AgentState.WAIT;
  }
  // ── Autofly engagement gate (shared streak gate for both triggers) ──
  // Both --debug-autofly and an active peer channel share the SAME streak >=
  // threshold gate. The streak counts LLM stages WITHIN THE CURRENT TURN
  // (autofly "momentum"): it starts at 0 at PROMPT entry (resetStreak below)
  // and climbs 1 per LLM stage (llm.ts recordLlmSuccess). So this gate, which
  // runs at the NEXT PROMPT entry (end of the just-finished turn), sees the
  // count of LLM stages that turn: a turn with >= threshold (default 3) LLM
  // stages engages auto mode; a turn with fewer does not. The PROMPT-entry
  // reset makes the count strictly per-turn, so prior turns never carry over.
  //
  // ESC flips auto off and resets streak to 0 (auto-state.ts setAuto(false)),
  // so neither trigger re-engages auto until a turn again accumulates >=
  // threshold LLM stages. That window is when the user intervenes — e.g.
  // saying "try again" after a by-design git_commit rejection. Removing the
  // streak gate from either trigger would re-engage auto immediately after
  // ESC and reject the commit again with no breathing room.
  //
  // The comparison is `>=` (not `>`), so with the default threshold 3 the
  // streak needs to reach exactly 3 to engage. The || short-circuits
  // hasActiveChannel() away when isDebugAutofly() is true, so the channel
  // path's side effects (listChannels readdirSync + a writeChannelFile write
  // to persist a discovered peerSessionId) never run on a --debug-autofly-only
  // session. The && short-circuits the whole expression when streak <
  // threshold, so the gate is cheap on the common post-ESC path.
  //
  // This gate covers channels joined BEFORE the loop reached PROMPT. A channel
  // joining MID-PROMPT (after this gate fell through but while ask()/
  // waitForInput() is blocked) is handled by Layer B — the try/catch around
  // getInput() below, which catches a PromptAbortError rejection and returns
  // WAIT. Layer B engages auto unconditionally because a channel DID just join
  // (the event itself is the signal); the next PROMPT then re-applies this
  // streak gate.
  if ((isDebugAutofly() || ctx.peer.hasActiveChannel()) && autoState.getStreak() >= autoState.getAutoflyThreshold()) {
    autoState.setAuto(true); // engage auto mode so subsequent loops take path 1
    console.log(chalk.gray('auto mode is on.'));
    return AgentState.WAIT;
  }

  // ── Per-turn streak reset ──
  // The autofly streak counts LLM stages WITHIN THE CURRENT TURN. Reset it to
  // 0 at the start of every turn (every PROMPT entry that falls through the
  // auto/autofly gates above) so prior turns never carry over. This subsumes
  // the old fresh-input resetStreak() (which only covered the Priority-3
  // input-provider path and missed the slash-query and initial-query paths):
  // resetting here covers all turn-start paths uniformly. The two early
  // returns above (auto already on; autofly gate engaged) intentionally skip
  // this reset — in the auto-on case the streak is irrelevant (the loop is
  // already autonomous), and in the gate-engaged case setAuto(true) just
  // happened, which itself resets the streak.
  autoState.resetStreak();

  // Reset brief nudge when entering PROMPT state (start of new turn)
  turn.nextBriefNudge = 5;

  let query: string | null;

  // Serve-mode flag, hoisted to function scope so both the Priority 3 input
  // loop (multi-line editor guard) and the downstream steering/file/user-log
  // logic can reference it without a redundant accessor call.
  const hub = getServeHub();

  // Priority 1: pending slash query (from /load)
  if (env.pendingSlashQuery !== null) {
    query = env.pendingSlashQuery;
    env.pendingSlashQuery = null;
    console.log(chalk.gray(`Loaded query: ${query.slice(0, 50)}${query.length > 50 ? '...' : ''}`));
  }
  // Priority 2: restored session initial query (first turn only)
  else if (initialQuery !== null) {
    query = initialQuery;
    initialQuery = null;
    console.log(chalk.gray(`Restored query: ${query.slice(0, 50)}${query.length > 50 ? '...' : ''}`));
  }
  // Priority 3: ask the input provider (with optional pre-fill from editor reload)
  else {
    let p0Input: string | null = null;

    while (true) {
      // Layer B — catch a peer channel joining MID-PROMPT (after the Layer A
      // gate above was checked but while ask()/waitForInput() is blocked here).
      // The channel-join event rejects the blocked Promise with a
      // PromptAbortError (terminal via AgentIO.abortAsk, serve via
      // ServeHub.rejectInput); that rejection propagates as a thrown exception
      // through UserInputProvider.getInput() / WebInputProvider.getInput() to
      // here. We catch it and redirect to WAIT — the channel is now active, so
      // the next PROMPT entry takes the Layer A hasActiveChannel() path. Any
      // other thrown error is a genuine failure: re-throw so it surfaces.
      try {
        p0Input = await inputProvider.getInput(p0Input ?? undefined);
      } catch (e) {
        if (e instanceof PromptAbortError) {
          autoState.setAuto(true); // engage auto; channel is active now
          return AgentState.WAIT;
        }
        throw e;
      }

      // null = autonomous skip or EOF → proceed without user message
      if (p0Input === null) {
        console.log(chalk.gray('(autonomous iteration)'));
        env.ctx.core.resetConfusionIndex();
        env.crossroadOccurred = false;  // clear stale cooldown at turn start
        // Reset sequence boundary and per-turn hook state for the autonomous
        // path too. markPromptBoundary() and resetTurn() are called on the
        // real-user-query path (below), but this autonomous null-skip early
        // return bypassed them — so in daemon/--auto mode, turn.* hook
        // conditions accumulated across all iterations (never cleared) and
        // the per-turn stop+block/replace hook dedup cap never refreshed
        // (stopDisturbance is only cleared by resetTurn()). Calling them here
        // keeps both COLLECT-bound paths consistent.
        env.sequence.markPromptBoundary();
        env.hookExecutor.resetTurn();
        return AgentState.COLLECT;
      }

      // Exit commands (only handled when not pre-filled — i.e., first iteration)
      if (['q', 'exit', 'quit', ''].includes(p0Input.trim().toLowerCase())) {
        return null; // signal machine exit
      }

      // Multi-line input: trailing backslash or Chinese enumeration comma opens editor.
      // Never triggered in serve/webui mode — the terminal-based editor makes no
      // sense there; webui queries are always single-line submissions.
      const isMultiline = !hub.isRunning()
        && (p0Input.endsWith('、') || (p0Input.endsWith('\\') && p0Input.trim() !== '\\'));
      if (isMultiline) {
        const result = await openMultilineEditor(p0Input.slice(0, -1));
        if (result.action === 'submit' && !result.content) {
          console.log(chalk.gray('Multi-line input cancelled.'));
          return AgentState.PROMPT;
        }
        if (result.action === 'reload') {
          // Reload: loop back to p0 with content pre-filled on the input line.
          // Clear stale wrap-up state so it doesn't bleed into the next p0 prompt.
          clearWrapUp();
          p0Input = result.content;
          continue;
        }
        // Submit: use the editor content
        p0Input = result.content;
      }

      query = p0Input;
      break;
    }

    // Fresh user input just arrived (normal query, slash typed at the prompt,
    // or a bang command). The autofly streak was already reset to 0 at the top
    // of this PROMPT entry (the per-turn reset, which covers all turn-start
    // paths uniformly), so no reset is needed here. The restored
    // pendingSlashQuery / initialQuery paths above and this input-provider
    // path all share that single reset. The autonomous null-skip path returns
    // early above (also after the per-turn reset).
  }

  // Bang commands: execute via hand_over tool
  if (query.trim().startsWith('!')) {
    // An empty command (user typed just "!") means "open an interactive
    // shell with no initial command". Pass the empty string through rather
    // than coercing to undefined — hand_over distinguishes "" (open a plain
    // shell) from a real command, and `undefined` would be stringified into
    // the literal text "undefined" typed into the pane.
    const command = query.trim().slice(1).trim();
    const result = await loader.execute('hand_over', env.ctx, {
      command,
      intent: `RUN USER TO execute interactive command from user`,
    });
    triologue.note('REMINDER', result);
    env.ctx.core.resetConfusionIndex();
    env.crossroadOccurred = false;  // clear stale cooldown at turn start
    return AgentState.PROMPT;
  }

  // Slash command routing
  if (query.trim().startsWith('/')) {
    setSlashQuery(query.trim());
    return AgentState.SLASH;
  }

  // Quick-return ESC: Handle wrap-up timing logic
  // The wrap-up turn is already in the triologue (from beginWrapUp + finishWrapUp).
  // We just need to commit or rollback based on timing.
  //
  // IMPORTANT: this MUST run BEFORE the steering/file-drain block below.
  // During the interrupted run the file uploads / steering notes were drained
  // into the triologue as a [REMINDER] note that got COMBINED into the
  // [WRAP_UP] user message (triologue.note() merges into the last user message).
  // If the wrap-up then rolls back (e.g. the wrap-up LLM returned empty or did
  // not complete before this PROMPT), rollbackWrapUp() truncates the whole
  // merged message — silently dropping the uploaded-file reminder the model
  // needed to see. Resolving the wrap-up FIRST means any reminder injected
  // afterwards lands past the rollback point and survives.
  if (triologue.hasActiveWrapUp()) {
    const action = evaluateWrapUp();
    if (action === 'commit') {
      triologue.commitWrapUp();  // keep user_wrap + agent_wrap permanently
    } else {
      triologue.rollbackWrapUp();  // remove user_wrap (and agent_wrap if present)
    }
  }

  clearWrapUp();

  // Steering synthesis (webui-only): if serve is running and the user queued
  // steering notes during the previous (now-interrupted) run, synthesize them
  // with the fresh query via forkChat. This preserves informational value
  // while dropping stale actionable direction. Only applies when the query
  // came from the input provider (not slash/initial-query), since those paths
  // represent restored/automated state, not a fresh post-interrupt submission.
  // At this point query is guaranteed non-null (the input-provider loop sets
  // it only after the null-check, and the slash/initial paths set non-null),
  // so we narrow with a const binding for type safety inside the closure.
  if (hub.isRunning() && query !== null) {
    const staleNotes = hub.getSteeringNotes();
    if (staleNotes.length > 0) {
      const freshQuery: string = query;
      const fullMessages = [...triologue.getMessages()];
      const tools = loader.getToolsForScope(env.scope);
      const synthesized = await env.ctx.core.escAware(
        async (ac) => synthesizeWithSteering(fullMessages, tools, freshQuery, staleNotes, ac.signal),
        () => freshQuery,
      );
      query = synthesized;
      // Drain the steering queue regardless of synthesis success — the notes
      // were consumed by the synthesis attempt, so they must not linger for
      // COLLECT to inject again (would double-count).
      hub.drainSteering();
      agentIO.verbose('steer', `Synthesized ${staleNotes.length} stale steering note(s) into fresh query`);
    }

    // Drain uploaded files (webui-only): if files were queued during the
    // interrupted run, save them now so the LLM can see them in the next turn.
    // Unlike steering notes, file uploads don't need synthesis — they are
    // informational resources to be saved and noted.
    const staleFiles = hub.drainFileUploads();
    if (staleFiles.length > 0) {
      const uploadDir = path.join(process.cwd(), '.mycc', 'uploaded');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const fileInfos: string[] = [];
      for (const file of staleFiles) {
        const safeName = `${Date.now()}_${file.filename}`;
        const filePath = path.join(uploadDir, safeName);
        fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
        const relPath = path.relative(process.cwd(), filePath);
        fileInfos.push(`- ${file.filename} → ${relPath} (${file.mimeType})${file.text ? `\n  Text: "${file.text.slice(0, 200)}${file.text.length > 200 ? '...' : ''}"` : ''}`);
      }
      triologue.note('REMINDER', `Previously uploaded file(s) (from interrupted run):\n${fileInfos.join('\n')}`);
      agentIO.verbose('serve', `Saved ${staleFiles.length} stale uploaded file(s) at PROMPT`);
    }
  }

  // Add user message to triologue
  triologue.user(query);
  turn.lastUserQuery = query;
  env.ctx.core.resetConfusionIndex();
  env.crossroadOccurred = false;  // clear stale cooldown at turn start

  // Persist the real user query to the user-log JSONL so it survives a page
  // refresh and re-renders as a right-side user bubble. The triologue's
  // role:'user' entries are polluted with injected system notes, so the user
  // log is the single source of truth for genuine user bubbles. Only when
  // serve is running (terminal mode has no webui to refresh).
  if (hub.isRunning()) {
    hub.appendUserLog(query, 'prompt');
  }

  // Reset sequence to current turn (hooks only see events since last user query)
  env.sequence.markPromptBoundary();
  // Reset per-turn hook state (stop+block/replace hooks may act once per turn)
  env.hookExecutor.resetTurn();

  // Capture first query as bookmark title. resolveHeadlessFirstQuery unifies
  // the two capture cases into one session-layer call: a plain empty
  // first_query (normal interactive start) is written directly, and a
  // HEADLESS_FIRST_QUERY_MARKER (--auto started idle, the user pressed ESC
  // to leave auto mode, and typed the first real query) is replaced with
  // the real query — same archive outcome either way.
  if (!bookmarkCaptured) {
    if (resolveHeadlessFirstQuery(sessionFilePath, query)) {
      bookmarkCaptured = true;
    }
  }

  // Extract English keywords from user query for proactive skill discovery.
  // Runs asynchronously with ESC support — on interrupt, silently yields empty.
  turn.extractedKeywords = await env.ctx.core.escAware(
    async (ac) => extractKeywords(query, ac.signal),
    () => [] as string[],
  );

  if (isDebuggingPrompt() && turn.extractedKeywords.length > 0) {
    console.log(chalk.yellow(`[debug-prompt] keywords: ${turn.extractedKeywords.join(', ')}`));
  }

  return AgentState.COLLECT;
}
