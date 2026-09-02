/**
 * await.ts - AWAIT state handler (autonomous mode)
 *
 * Replaces the PROMPT stage in auto mode. Instead of prompting the user,
 * the loop blocks here until an external event arrives — a new mail, a
 * teammate state change (question / finished / mail), or a webui steering
 * note — then transitions to COLLECT to process the event. This is the
 * core of "autonomous mycc": multiple instances can chain by writing to
 * each other's mailbox, each blocking in AWAIT until roused.
 *
 * Entry: PROMPT redirects to AWAIT when auto mode is on (or when the
 *        --debug-autofly autofly trigger engages it). STOP always routes
 *        to PROMPT, which is the single decision point for the AWAIT
 *        redirect.
 * Exit:
 *   - COLLECT — an event arrived (mail / teammate / steering).
 *   - PROMPT  — the user pressed ESC to leave auto mode (neglected mode
 *               is set by the ESC handler; we clear auto and fall back to
 *               the interactive prompt). Plan/normal mode is preserved —
 *               auto is orthogonal and only governs prompting.
 *
 * EVENT DETECTION is delegated to the unified `awaitTeammates` primitive
 * (ctx.team.awaitTeammates), which polls teammate status + mailbox +
 * steering + ESC + a max-wait safety valve every 1s and returns the typed
 * reason it stopped. AWAIT does NOT accept 'all done' or 'timeout' as
 * exits: a teammate being merely idle is not a new event (the next event
 * may be peer mail, a steering note, or a teammate waking back up), so the
 * wait stays unbounded until a genuine new event arrives or ESC exits auto
 * mode. The while-loop only re-checks `getAuto()` between bounded 60s
 * waits, so a programmatic setAuto(false) (without ESC) still exits — this
 * is AWAIT-specific auto-mode gating that cannot live in the primitive
 * without coupling it to autoState (the `tm_await` tool needs to wait
 * regardless of auto state).
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { autoState } from '../auto-state.js';

export async function handleWait(
  env: MachineEnv,
  _turn: TurnVars,
  _chat: ChatData,
): Promise<HandlerResult> {
  const { ctx } = env;

  // Block until a teammate/steering/mail event or ESC exits auto mode.
  // 'all done' (teammates idle) and 'timeout' are NOT exits — re-check
  // autoState between bounded 60s waits and re-await. All event detection
  // (status / mail / steering / ESC) is delegated to awaitTeammates.
  while (autoState.getAuto()) {
    const reason = await ctx.team.awaitTeammates({
      reasons: ['holding', 'mail', 'steering', 'esc', 'timeout'],
      timeoutMs: 60_000,
    });

    if (reason === 'esc') {
      autoState.setAuto(false);
      agentIO.setNeglectedMode(false);
      agentIO.flushOutput();
      console.log(chalk.gray('auto mode is off. Prompt resumed.'));
      return AgentState.PROMPT;
    }

    if (reason === 'timeout') {
      continue; // re-check autoState, then re-await
    }

    // holding / mail / steering → COLLECT to process the event.
    return AgentState.COLLECT;
  }

  // Programmatic auto-off (setAuto(false) without ESC) → PROMPT.
  return AgentState.PROMPT;
}