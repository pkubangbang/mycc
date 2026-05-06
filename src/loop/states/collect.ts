/**
 * collect.ts - COLLECT state handler
 *
 * Pre-LLM pipeline: child questions, mail collection,
 * hint round, todo nudging, brief nudging,
 * role sequence validation.
 */

import chalk from 'chalk';
import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';

// Confusion threshold for hint generation
const CONFUSION_THRESHOLD = 10;
// Minimum message count before hint generation
const MIN_MESSAGES_FOR_HINT = 6;

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
  const confusionIndex = ctx.core.getConfusionIndex();
  const messageCount = triologue.getMessagesRaw().length;
  const lastRole = triologue.getLastRole();
  
  if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
    // Only generate hint after a valid transition point (assistant or tool message)
    if (lastRole === 'assistant' || lastRole === 'tool') {
      agentIO.log(chalk.blue('[hint round] Generating problem analysis...'));
      const result = await triologue.generateHintRound(confusionIndex, `Score: ${confusionIndex}`);
      // If aborted (ESC pressed), skip to PROMPT to show prompt immediately
      if (result === 'aborted') {
        return AgentState.PROMPT;
      }
      // Reset confusion after hint
      ctx.core.resetConfusionIndex();
    }
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

  // 5. Brief nudging - remind agent to use brief tool
  turn.nextBriefNudge--;
  if (turn.nextBriefNudge <= 0) {
    triologue.user('<reminder>Provide a brief status update using the brief tool. Example: brief("Working on X", 7)</reminder>');
    turn.nextBriefNudge = 5;
  }

  // 6. Validate role sequence before LLM call
  if (lastRole === 'assistant') {
    triologue.user('Continue with your task.');
  }

  return AgentState.LLM;
}
