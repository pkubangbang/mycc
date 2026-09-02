/**
 * stop.ts - STOP state handler
 *
 * Handles the no-tool-call case: neglected mode wrap-up or team awaiting.
 * Branches to COLLECT (continue working) or PROMPT (turn complete).
 *
 * CENTRALIZED NEGLECTION WRAP-UP:
 * This is the single choke point for all ESC/neglection wrap-up. When any
 * state handler (LLM, TOOL, COLLECT, HOOK) detects neglection mid-execution,
 * it returns STOP (instead of PROMPT). STOP's neglection block then either:
 *   - Calls startWrapUp() for a background letter-box summary (mid-execution
 *     ESC paths — last triologue role is NOT 'assistant'), or
 *   - Calls presentResult() to display the LLM's text-only response (the
 *     HOOK→STOP path where the LLM ran in neglected mode with empty tools —
 *     last triologue role IS 'assistant').
 * The AWAIT handler is the exception: it turns off auto mode and returns
 * PROMPT directly (no wrap-up needed — the previous turn already presented
 * its result via STOP→PROMPT before entering AWAIT).
 */

import chalk from 'chalk';
import { AgentState, presentResult } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { autoState } from '../auto-state.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { loader } from '../../context/shared/loader.js';
import { stopSpinner } from '../../engine/chat-helpers.js';
import { getServeHub } from '../../serve/serve-registry.js';

export async function handleStop(
  env: MachineEnv,
  _turn: TurnVars,
  _chat: ChatData,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  try {
    // ── Universal neglection wrap-up (centralized) ──
    // Any state handler that detects neglection returns STOP. This block
    // handles ALL neglection paths: mid-execution ESC (LLM/TOOL/COLLECT/HOOK)
    // and the HOOK→STOP text-only-response path.
    if (agentIO.isNeglectedMode()) {
      // ESC always means "give me control back". If we were in auto mode,
      // exit it now — auto is orthogonal to plan/normal, so plan/normal is
      // preserved; we only stop the autonomous loop and return to PROMPT.
      if (autoState.getAuto()) {
        autoState.setAuto(false);
        console.log(chalk.gray('auto mode is off. Prompt resumed.'));
      }

      // Branch on the last triologue role:
      // - 'assistant' → HOOK→STOP path: the LLM ran in neglected mode (empty
      //   tools) and produced a text-only response. The text IS the final
      //   response — display it via presentResult. No startWrapUp needed.
      // - anything else → direct ESC→STOP path: ESC fired mid-execution
      //   (during LLM call, tool execution, hint generation, or recap). The
      //   LLM did not produce a usable response. Start a background wrap-up
      //   so the user sees a letter-box summary while the prompt shows ASAP.
      if (triologue.getLastRole() === 'assistant') {
        agentIO.setNeglectedMode(false); // Clear FIRST for isInteractionMode()

        const teammates = ctx.team.listTeammates();
        if (teammates.some((t) => t.status === 'working')) {
          agentIO.log(chalk.yellow('teammates still working (use /team to check status)'));
        }

        agentIO.flushOutput();
        presentResult(triologue);
        return AgentState.PROMPT;
      }

      // Mid-execution ESC path: start background wrap-up for a letter-box summary.
      stopSpinner(); // Ensure spinner is stopped before returning to PROMPT
      const tools = loader.getToolsForScope(env.scope);
      startWrapUp(triologue, tools);
      agentIO.setNeglectedMode(false);
      return AgentState.PROMPT;
    }

    // Normal mode: wait for teammates (each respects their ETA deadline)
    // Show the final response (letter-box) BEFORE awaiting, so the user sees
    // the result immediately and doesn't think the lead is frozen while it
    // waits on teammates. The PROMPT state's `agent >>` is suppressed during
    // the await (we're blocked here, not at the input prompt); instead we log
    // an "awaiting teammate(s)" notice so the user knows why there's no prompt.
    presentResult(triologue);

    const teammates = ctx.team.listTeammates();
    if (teammates.some((t) => t.status === 'working')) {
      agentIO.log(
        chalk.yellow('awaiting teammate(s) — use /team to check status, or ESC to interrupt'),
      );
    }

    // Event-polling wait: re-read live teammate status + mailbox + steering on
    // every tick, instead of blocking on a one-shot awaitTeam() that can miss
    // transitions or misreport 'all done'. This mirrors AWAIT's eventPending()
    // pattern but works in manual mode (not gated on autoState).
    // The teammate's heartbeat (30s progress mail), status transitions (IPC),
    // and watchdog reports ARE the event stream that pumps this loop.
    const TEAM_POLL_MS = 1000;
    // Safety valve: if a teammate stays 'working' but never sends mail and
    // never changes status (e.g. a hung process that emits no watchdog report),
    // the loop would poll forever. Cap the total wait and fall back to the old
    // 'timeout' behavior (COLLECT + SYSTEM note) so the lead can't stall.
    const TEAM_MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
    const waitStart = Date.now();

    while (true) {
      // ESC pressed — return to PROMPT so the user can intervene.
      if (agentIO.isNeglectedMode()) {
        return AgentState.PROMPT;
      }

      // Re-read live teammate status every tick (not a snapshot).
      const liveTeammates = ctx.team.listTeammates();
      const hasWorking = liveTeammates.some((t) => t.status === 'working');
      const hasHolding = liveTeammates.some((t) => t.status === 'holding');

      // Event 1: a teammate is holding (has a question for the lead).
      if (hasHolding) {
        return AgentState.COLLECT;
      }

      // Event 2: no working teammates AND no holding → all done.
      // (Idle/shutdown teammates are not events; they are the resting state.)
      if (!hasWorking) {
        return AgentState.PROMPT;
      }

      // Event 3: new mail arrived (teammate heartbeat, watchdog report, etc.).
      if (ctx.mail.hasNewMails()) {
        return AgentState.COLLECT;
      }

      // Event 4: WebUI steering note queued by the user.
      const steerPending =
        getServeHub().isRunning() && getServeHub().getSteeringNotes().length > 0;
      if (steerPending) {
        return AgentState.COLLECT;
      }

      // Safety valve: max-wait exceeded while a teammate is still working.
      if (Date.now() - waitStart >= TEAM_MAX_WAIT_MS) {
        const teamInfo = ctx.team.printTeam();
        triologue.note(
          'SYSTEM',
          `Timeout waiting for teammates.\n${teamInfo}\n\n` +
          `Use tm_await to wait longer, or tm_remove to terminate.`,
        );
        return AgentState.COLLECT;
      }

      // No event yet — sleep briefly and re-check. The 1s poll keeps the wait
      // responsive to teammate transitions without busy-spinning. Teammate
      // heartbeats (30s) and status IPCs are picked up on the next tick.
      await new Promise((resolve) => setTimeout(resolve, TEAM_POLL_MS));
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'stop', `STOP state error: ${errorMessage}`);
    return AgentState.PROMPT;
  }
}
