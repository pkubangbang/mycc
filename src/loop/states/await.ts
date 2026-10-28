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

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { autoState } from '../auto-state.js';
import { exitAutoMode } from '../exit-auto.js';
import { agentIO } from '../agent-io.js';

export async function handleWait(
  env: MachineEnv,
  _turn: TurnVars,
  _chat: ChatData,
): Promise<HandlerResult> {
  const { ctx } = env;

  // AWAIT is a STATE the user must be able to see: "waiting for an event" and
  // "hung" look identical otherwise, and in auto mode there is no prompt to
  // contradict it (REPORT row 35). One line on entry — not per tick, which
  // would flood the transcript every 60s — naming what we wait for and how to
  // leave.
  ctx.core.brief(
    'info',
    'await',
    'AWAIT — auto mode: waiting for an event (mail, teammate, steering). ESC leaves auto mode.',
  );
  let ticks = 0;

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
      // Single owner of the ESC exit (the STOP state calls the same helper
      // when the ESC landed mid-execution instead of while blocked here).
      exitAutoMode('await');
      return AgentState.PROMPT;
    }

    if (reason === 'timeout') {
      // Still waiting is a fact worth recording, but NOT a chat message: this
      // loop is unbounded, so a brief per tick would add one bubble a minute
      // forever. The verbose trace carries it instead (the state machine
      // already logs the AWAIT transition there).
      ticks++;
      agentIO.verbose('await', `still waiting — no event yet (${ticks} min elapsed)`);
      continue; // re-check autoState, then re-await
    }

    // holding / mail / steering → COLLECT to process the event.
    ctx.core.brief('info', 'await', `event received (${reason}) — waking up`);
    return AgentState.COLLECT;
  }

  // Programmatic auto-off (setAuto(false) without ESC) → PROMPT.
  return AgentState.PROMPT;
}