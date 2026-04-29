/**
 * collect.ts - COLLECT state handler
 *
 * Pre-LLM pipeline: child questions, mail collection,
 * hint round, todo nudging, role sequence validation.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';

export async function handleCollect(
  env: MachineEnv,
  turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  // 1. Handle pending questions from children
  await ctx.team.handlePendingQuestions();

  // 2. Collect mails
  const mails = ctx.mail.collectMails();
  if (mails.length > 0) {
    const mailContent = mails
      .map((mail) => `Mail from ${mail.from}: ${mail.title}\n${mail.content}`)
      .join('\n\n---\n\n');

    if (agentIO.isNeglectedMode()) {
      triologue.user(`[URGENT: user interrupted - wrap up quickly]\n${mailContent}`);
    } else {
      triologue.user(mailContent);
    }
  }

  // 3. Generate hint round if confusion threshold reached
  if (triologue.needsHintRound()) {
    agentIO.log(chalk.blue('[hint round] Generating problem analysis...'));
    await triologue.generateHintRound();
  }

  // 4. Todo nudging with state tracking
  if (ctx.todo.hasOpenTodo()) {
    const currentTodoState = ctx.todo.printTodoList();
    if (currentTodoState !== turn.lastTodoState) {
      turn.nextTodoNudge = 3;
      turn.lastTodoState = currentTodoState;
    }
    turn.nextTodoNudge--;
    if (turn.nextTodoNudge === 0) {
      triologue.user(`<reminder>Update your todos. ${ctx.todo.printTodoList()}</reminder>`);
      turn.nextTodoNudge = 3;
    }
  }

  // 5. Validate role sequence before LLM call
  const lastRole = triologue.getLastRole();
  if (lastRole === 'assistant') {
    triologue.user('Continue with your task.');
  }

  return AgentState.LLM;
}
