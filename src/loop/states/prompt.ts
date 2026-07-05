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
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { openMultilineEditor } from '../../utils/multiline-input.js';
import { readSession, writeSession } from '../../session/index.js';
import { setSlashQuery } from './slash.js';
import { evaluateWrapUp, clearWrapUp } from '../esc-wrap-up.js';
import { extractKeywords } from '../keyword-extractor.js';
import { isDebuggingPrompt } from '../../config.js';

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
