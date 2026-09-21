/**
 * /clear command - Clear conversation history, todos, issues, and sequence state
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { Triologue } from '../loop/triologue.js';
import { clearWrapUp } from '../loop/esc-wrap-up.js';
import { skillSuggester } from '../loop/states/collect-skill.js';

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
    // Reset the skill-discovery singleton's throttle state. /clear returns
    // PROMPT from SLASH, so the state-machine turn-boundary guard (which
    // excludes the SLASH→PROMPT transition) does NOT reset the singleton.
    // Explicit reset keeps the "start fresh" intent self-evident and defends
    // against any future code that mutates the singleton between the prior
    // turn boundary and /clear.
    skillSuggester.reset();
    console.log(chalk.green('Conversation, todos, and issues cleared. Starting fresh.'));
  },
};