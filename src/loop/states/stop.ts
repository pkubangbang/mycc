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
 * The WAIT handler is the exception: it turns off auto mode and returns
 * PROMPT directly (no wrap-up needed — the previous turn already presented
 * its result via STOP→PROMPT before entering WAIT).
 */

import chalk from 'chalk';
import { AgentState, presentResult } from '../state-machine.js';
import type { MachineEnv, TurnVars, ChatData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { autoState } from '../auto-state.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { loader } from '../../context/shared/loader.js';
import { stopSpinner } from '../../engine/chat-helpers.js';

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
    const { result } = await ctx.team.awaitTeam();

    if (result === 'got question' || ctx.mail.hasNewMails()) {
      return AgentState.COLLECT;
    }

    if (result === 'timeout') {
      const teamInfo = ctx.team.printTeam();
      triologue.note(
        'SYSTEM',
        `Timeout waiting for teammates.\n${teamInfo}\n\n` +
        `Use tm_await to wait longer, or tm_remove to terminate.`,
      );
      return AgentState.COLLECT;
    }

    // 'all done' or 'no teammates'
    presentResult(triologue);

    return AgentState.PROMPT;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'stop', `STOP state error: ${errorMessage}`);
    return AgentState.PROMPT;
  }
}
