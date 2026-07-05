/**
 * stop.ts - STOP state handler
 *
 * Handles the no-tool-call case: neglected mode wrap-up or team awaiting.
 * Branches to COLLECT (continue working) or PROMPT (turn complete).
 */

import chalk from 'chalk';
import { AgentState, presentResult } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';

export async function handleStop(
  env: MachineEnv,
  _turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  try {
    // Neglected mode wrap-up: LLM produced text-only response (no tools)
    // after user pressed ESC. The text IS the final response.
    if (agentIO.isNeglectedMode()) {
      agentIO.setNeglectedMode(false); // Clear FIRST for isInteractionMode()

      const teammates = ctx.team.listTeammates();
      if (teammates.some((t) => t.status === 'working')) {
        agentIO.log(chalk.yellow('teammates still working (use /team to check status)'));
      }

      agentIO.flushOutput();
      presentResult(triologue);
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
