/**
 * slash.ts - SLASH state handler
 *
 * Handles slash commands (e.g., /team, /load, /help).
 * Bidirectional with PROMPT: PROMPT detects '/', routes to SLASH,
 * SLASH executes and returns to PROMPT.
 *
 * When a command sets nextQuery (e.g., /load), it is stored on
 * env.pendingSlashQuery for the PROMPT handler to consume.
 */

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import type { SlashCommandContext } from '../../types.js';
import { slashRegistry } from '../../slashes/index.js';

/** The raw query string that triggered the slash route. Set by PROMPT. */
let slashQuery = '';

export function setSlashQuery(query: string): void {
  slashQuery = query;
}

export async function handleSlash(
  env: MachineEnv,
  _turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { ctx, triologue, sessionFilePath } = env;
  const query = slashQuery;
  slashQuery = '';

  // Parse command name
  const parts = query.split(/\s+/);
  const cmdName = parts[0].slice(1); // Remove '/'

  const slashCtx: SlashCommandContext = {
    query,
    args: parts,
    ctx,
    triologue,
    sessionFilePath,
  };

  const handled = await slashRegistry.execute(cmdName, slashCtx);

  // If slash command (e.g. /load) produced a query to process,
  // store it for prompt to pick up on re-entry.
  if (handled && slashCtx.nextQuery) {
    env.pendingSlashQuery = slashCtx.nextQuery;
  }

  return AgentState.PROMPT;
}
