/**
 * /clear command - Clear conversation history, todos, issues, and sequence state
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { Triologue } from '../loop/triologue.js';
import { clearWrapUp } from '../loop/esc-wrap-up.js';
import { skillSuggester, beginFreshSession } from '../loop/states/collect-skill.js';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear conversation history, todos, issues, and start fresh',
  handler: (context) => {
    const triologue = context.triologue as Triologue;
    triologue.clear();
    // fullClear() resets EVERYTHING including turn.events[] and totalTurns —
    // /clear starts a completely fresh session. This is the one place where
    // totalTurns is reset (alongside double-Ctrl+L in agent-repl.ts).
    context.sequence?.fullClear();
    // Reset hook dedup so a stop+replace hook suppressed by the per-turn cap
    // can re-fire after /clear — fullClear() resets the session.* counters
    // it was deduping against, but not the dedup set itself.
    context.hookExecutor?.resetTurn();
    clearWrapUp();
    context.ctx.todo.clear();
    context.ctx.issue.clearAll();
    // Fresh-session primitive: reset the skill-discovery throttle AND
    // invalidate the stale TurnVars composite sources. /clear returns PROMPT
    // from SLASH, so the state-machine turn-boundary guard (which excludes the
    // SLASH→PROMPT transition) does NOT run — resetting the suggester alone
    // would leave a stale `turn.lastUserQuery` that re-fires extraction on the
    // very next COLLECT against a conversation the user just cleared (PR #22
    // review, P1). The SLASH handler hands the live TurnVars in via ctx.turn.
    if (context.turn) {
      beginFreshSession(context.turn);
    } else {
      // Defensive fallback: no turn handle (should not happen for /clear).
      skillSuggester.reset();
    }
    console.log(chalk.green('Conversation, todos, and issues cleared. Starting fresh.'));
  },
};