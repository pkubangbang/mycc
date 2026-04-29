/**
 * prompt.ts - PROMPT state handler
 *
 * Entry point for each conversational turn. Handles:
 * - User input via InputProvider (or autonomous skip)
 * - Restored session initial query (first turn only)
 * - Pending slash query (from /load)
 * - Multi-line input (trailing backslash)
 * - Exit commands (q/exit/quit)
 * - Bang commands (!)
 * - Slash command routing (→ SLASH)
 * - Adding query to triologue
 * - Bookmark title capture
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { loader } from '../../context/shared/loader.js';
import { openMultilineEditor } from '../../utils/multiline-input.js';
import { readSession, writeSession } from '../../session/index.js';
import { setSlashQuery } from './slash.js';

/** Captured once per machine lifetime */
let bookmarkCaptured = false;

/** Restored session initial query (consumed on first prompt) */
let initialQuery: string | null = null;

export function setInitialQuery(query: string | null): void {
  initialQuery = query;
}

export async function handlePrompt(
  env: MachineEnv,
  _turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { triologue, inputProvider, sessionFilePath } = env;

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
  // Priority 3: ask the input provider
  else {
    query = await inputProvider.getInput();
  }

  // null = autonomous skip or EOF → proceed without user message
  if (query === null) {
    console.log(chalk.gray('(autonomous iteration)'));
    triologue.resetHint();
    return AgentState.COLLECT;
  }

  // Multi-line input: trailing backslash opens editor
  if (query.endsWith('\\') && query.trim() !== '\\') {
    const initialContent = query.slice(0, -1);
    const content = await openMultilineEditor(initialContent);
    if (content === null) {
      console.log(chalk.gray('Multi-line input cancelled.'));
      return AgentState.PROMPT;
    }
    query = content;
  }

  // Exit commands
  if (['q', 'exit', 'quit', ''].includes(query.trim().toLowerCase())) {
    return null; // signal machine exit
  }

  // Bang commands: execute via hand_over tool
  if (query.trim().startsWith('!')) {
    const command = query.trim().slice(1).trim();
    const result = await loader.execute('hand_over', env.ctx, {
      command: command || undefined,
      justification: command ? `User runs: ${command}` : 'Open terminal',
    });
    triologue.user(`[FYI] ${result}`);
    triologue.resetHint();
    return AgentState.PROMPT;
  }

  // Slash command routing
  if (query.trim().startsWith('/')) {
    setSlashQuery(query.trim());
    return AgentState.SLASH;
  }

  // Add user message to triologue
  triologue.user(query);
  triologue.resetHint();

  // Capture first query as bookmark title
  if (!bookmarkCaptured) {
    const session = readSession(sessionFilePath);
    if (session && !session.first_query) {
      session.first_query = query.slice(0, 100);
      writeSession(sessionFilePath, session);
      bookmarkCaptured = true;
    }
  }

  return AgentState.COLLECT;
}
