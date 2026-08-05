/**
 * wait.ts - WAIT state handler (autonomous mode)
 *
 * Replaces the PROMPT stage in auto mode. Instead of prompting the user,
 * the loop blocks here until an external event arrives — a new mail, a
 * teammate state change (question / finished / mail), or a webui steering
 * note — then transitions to COLLECT to process the event. This is the
 * core of "autonomous mycc": multiple instances can chain by writing to
 * each other's mailbox, each blocking in WAIT until roused.
 *
 * Entry: STOP returns WAIT when `ctx.core.getAuto()` is true.
 * Exit:
 *   - COLLECT — an event arrived (mail / teammate / steering).
 *   - PROMPT  — the user pressed ESC to leave auto mode (neglected mode
 *               is set by the ESC handler; we clear auto and fall back to
 *               the interactive prompt). Plan/normal mode is preserved —
 *               auto is orthogonal and only governs prompting.
 *
 * POLL design: checks are cheap (in-memory flags + tiny file read for
 * mail). A 1s poll keeps WAIT responsive without busy-spinning. Each poll
 * also re-checks `getAuto()` so a programmatic `setAuto(false)` exits WAIT
 * even without ESC, and `isNeglectedMode()` so ESC is honored promptly.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { getServeHub } from '../../serve/serve-registry.js';

/** Poll interval for the WAIT blocking loop (ms). */
const WAIT_POLL_MS = 1000;

/**
 * Check whether an event is already pending (mail, teammate, or steering).
 * Returns true as soon as one is available — caller transitions to COLLECT.
 */
function eventPending(env: MachineEnv): boolean {
  // 1. New mail in the lead's inbox.
  if (env.ctx.mail.hasNewMails()) {
    return true;
  }

  // 2. A teammate is holding (has a question for the lead) or working
  //    (may produce mail / a state change soon). Idle/shutdown alone do
  //    not warrant a COLLECT — nothing new to process.
  const teammates = env.ctx.team.listTeammates();
  if (teammates.some((t) => t.status === 'holding' || t.status === 'working')) {
    return true;
  }

  // 3. Webui steering notes queued by the user (mid-task direction).
  if (getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0) {
    return true;
  }

  return false;
}

export async function handleWait(
  env: MachineEnv,
  _turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { ctx, triologue } = env;

  // Fast path: an event is already pending → go straight to COLLECT.
  if (eventPending(env)) {
    // If a teammate is holding or working, wait for them so the lead sees
    // the resulting mail / question rather than spinning COLLECT→STOP→WAIT.
    const teammates = ctx.team.listTeammates();
    const active = teammates.some((t) => t.status === 'holding' || t.status === 'working');
    if (active) {
      await ctx.team.awaitTeam();
    }
    return AgentState.COLLECT;
  }

  // Block until an event arrives or ESC exits auto mode.
  while (true) {
    // ESC pressed → exit auto mode (orthogonal: plan/normal preserved).
    if (agentIO.isNeglectedMode()) {
      ctx.core.setAuto(false);
      agentIO.setAuto(false);
      agentIO.setNeglectedMode(false);
      agentIO.flushOutput();
      console.log(chalk.gray('auto mode is off. Prompt resumed.'));
      return AgentState.PROMPT;
    }

    // Programmatic auto-off (e.g. a tool cleared the flag).
    if (!ctx.core.getAuto()) {
      agentIO.setAuto(false);
      return AgentState.PROMPT;
    }

    if (eventPending(env)) {
      // A teammate becoming active means we should await their cycle so the
      // lead collects the resulting mail / question in one COLLECT pass.
      const teammates = ctx.team.listTeammates();
      const active = teammates.some((t) => t.status === 'holding' || t.status === 'working');
      if (active) {
        await ctx.team.awaitTeam();
      }
      return AgentState.COLLECT;
    }

    // Nothing pending — sleep briefly and re-check. escAware is not needed
    // here because we poll isNeglectedMode() each iteration; a plain delay
    // is fine and keeps WAIT cancelable within one poll interval.
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));

    // Suppress unused-warning while keeping triologue available for future
    // note injection if WAIT ever needs to log a heartbeat.
    void triologue;
  }
}