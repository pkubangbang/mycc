/**
 * exit-auto.ts - the SINGLE owner of "leave auto mode because ESC was pressed"
 *
 * ESC means "give me control back": the autonomous loop stops, the neglected
 * (ESC) mode is cleared, any pending output is flushed, and the user is told
 * once. Two states can observe the ESC — STOP (ESC landed mid-execution, so
 * the state handler returned STOP) and AWAIT (ESC landed while already blocked
 * waiting for an event). Both call this helper instead of open-coding the
 * sequence, so the four steps cannot drift apart and the message is printed
 * from exactly one place.
 *
 * Invariants kept here (do not re-derive in the callers):
 *   - auto is orthogonal to plan/normal: only the auto flag flips.
 *   - the flip is announced only when it happens (no "auto is off" line for a
 *     session that was never in auto mode).
 *   - flushOutput() runs BEFORE the caller returns to PROMPT, so the line is in
 *     the terminal/browser transcript before the prompt re-render.
 */

import chalk from 'chalk';
import { agentIO } from './agent-io.js';
import { autoState } from './auto-state.js';

/**
 * Leave auto mode after an ESC-driven exit.
 *
 * @param via - which state observed the ESC ('stop' | 'await'); logged
 *              verbosely so a reader can tell the two entry points apart in a
 *              trace without them diverging in behaviour.
 * @returns true when auto mode was actually on (i.e. a flip happened).
 */
export function exitAutoMode(via: 'stop' | 'await'): boolean {
  const wasAuto = autoState.getAuto();
  if (wasAuto) {
    autoState.setAuto(false);
  }
  // Always clear neglected mode + flush: the AWAIT path relies on it for the
  // prompt re-render, and in STOP it is idempotent (the STOP body clears it
  // again before presenting the result — clearing twice is harmless).
  agentIO.setNeglectedMode(false);
  agentIO.flushOutput();
  if (wasAuto) {
    console.log(chalk.gray('auto mode is off. Prompt resumed.'));
  }
  agentIO.verbose('auto', `leave auto mode via ${via} (wasAuto=${wasAuto})`);
  return wasAuto;
}
