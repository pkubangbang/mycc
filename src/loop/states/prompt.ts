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
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { openMultilineEditor } from '../../utils/multiline-input.js';
import { readSession, writeSession } from '../../session/index.js';
import { setSlashQuery } from './slash.js';
import { evaluateWrapUp, clearWrapUp } from '../esc-wrap-up.js';
import { extractKeywords } from '../keyword-extractor.js';
import { isDebuggingPrompt } from '../../config.js';
import { forkChat } from '../../engine/chat-provider.js';
import type { RetryConfig } from '../../engine/chat-helpers.js';
import { getServeHub } from '../../serve/serve-registry.js';
import { agentIO } from '../agent-io.js';

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
  _pass: PassData,
): Promise<HandlerResult> {
  const { triologue, inputProvider, sessionFilePath } = env;

  // Reset brief nudge when entering PROMPT state (start of new turn)
  turn.nextBriefNudge = 5;

  let query: string | null;

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
      p0Input = await inputProvider.getInput(p0Input ?? undefined);

      // null = autonomous skip or EOF → proceed without user message
      if (p0Input === null) {
        console.log(chalk.gray('(autonomous iteration)'));
        env.ctx.core.resetConfusionIndex();
        env.crossroadOccurred = false;  // clear stale cooldown at turn start
        return AgentState.COLLECT;
      }

      // Exit commands (only handled when not pre-filled — i.e., first iteration)
      if (['q', 'exit', 'quit', ''].includes(p0Input.trim().toLowerCase())) {
        return null; // signal machine exit
      }

      // Multi-line input: trailing backslash or Chinese enumeration comma opens editor
      if ((p0Input.endsWith('\\') && p0Input.trim() !== '\\') || p0Input.endsWith('、')) {
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
  }

  // Bang commands: execute via hand_over tool
  if (query.trim().startsWith('!')) {
    const command = query.trim().slice(1).trim();
    const result = await loader.execute('hand_over', env.ctx, {
      command: command || undefined,
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

  // Steering synthesis (webui-only): if serve is running and the user queued
  // steering notes during the previous (now-interrupted) run, synthesize them
  // with the fresh query via forkChat. This preserves informational value
  // while dropping stale actionable direction. Only applies when the query
  // came from the input provider (not slash/initial-query), since those paths
  // represent restored/automated state, not a fresh post-interrupt submission.
  // At this point query is guaranteed non-null (the input-provider loop sets
  // it only after the null-check, and the slash/initial paths set non-null),
  // so we narrow with a const binding for type safety inside the closure.
  const hub = getServeHub();
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

  // Quick-return ESC: Handle wrap-up timing logic
  // The wrap-up turn is already in the triologue (from beginWrapUp + finishWrapUp).
  // We just need to commit or rollback based on timing.
  if (triologue.hasActiveWrapUp()) {
    const action = evaluateWrapUp();
    if (action === 'commit') {
      triologue.commitWrapUp();  // keep user_wrap + agent_wrap permanently
    } else {
      triologue.rollbackWrapUp();  // remove user_wrap (and agent_wrap if present)
    }
  }

  clearWrapUp();

  // Add user message to triologue
  triologue.user(query);
  turn.lastUserQuery = query;
  env.ctx.core.resetConfusionIndex();
  env.crossroadOccurred = false;  // clear stale cooldown at turn start

  // Reset sequence to current turn (hooks only see events since last user query)
  env.sequence.markPromptBoundary();

  // Capture first query as bookmark title
  if (!bookmarkCaptured) {
    const session = readSession(sessionFilePath);
    if (session && !session.first_query) {
      session.first_query = query.slice(0, 100);
      writeSession(sessionFilePath, session);
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
