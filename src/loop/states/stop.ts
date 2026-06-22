/**
 * stop.ts - STOP state handler
 *
 * Handles the no-tool-call case: neglected mode wrap-up or team awaiting.
 * Branches to COLLECT (continue working) or PROMPT (turn complete).
 */

import chalk from 'chalk';
import * as fs from 'fs';
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
      writeAutoOutJsonl(triologue);
      return AgentState.PROMPT;
    }

    // Normal mode: wait for teammates
    const { result } = await ctx.team.awaitTeam(30000);

    if (result === 'got question' || ctx.mail.hasNewMails()) {
      return AgentState.COLLECT;
    }

    if (result === 'interrupted') {
      // ESC was pressed during awaitTeam - return to prompt
      return AgentState.PROMPT;
    }

    if (result === 'all done' || result === 'no workload' || result === 'no teammates') {
      presentResult(triologue);
      writeAutoOutJsonl(triologue);
      return AgentState.PROMPT;
    }

    if (result === 'timeout') {
      triologue.note(
        'TIMEOUT',
        `Timeout waiting for teammates. Use tm_await to wait longer, or check team status with /team. ${ctx.team.printTeam()}`,
      );
      return AgentState.COLLECT;
    }

    ctx.core.brief('warn', 'awaitTeam', `Unexpected result: ${result}`);
    return AgentState.COLLECT;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'stop', `STOP state error: ${errorMessage}`);
    return AgentState.PROMPT;
  }
}

/**
 * Write the last assistant reply to MYCC_AUTO_OUT_JSONL (if set).
 *
 * Gated only by MYCC_AUTO_OUT_JSONL — independent of MYCC_AUTO_IN_JSONL.
 * Terminal output (letter box) continues normally; this is additive.
 * Each line is in mailbox JSONL format so teammate's COLLECT/collectMails()
 * can parse it directly.
 */
function writeAutoOutJsonl(triologue: MachineEnv['triologue']): void {
  const outPath = process.env.MYCC_AUTO_OUT_JSONL;
  if (!outPath) return;

  const lastMsg = triologue.getMessagesRaw().at(-1);
  if (!lastMsg?.content) return;

  const mail = {
    id: Math.random().toString(36).substring(2, 10),
    from: process.env.MYCC_CONTAINER_NAME || 'container',
    title: 'Reply',
    content: lastMsg.content,
    timestamp: new Date().toISOString(),
  };

  try {
    fs.appendFileSync(outPath, JSON.stringify(mail) + '\n', 'utf-8');
  } catch {
    // Ignore write errors (file may not be mounted or writable)
  }
}
