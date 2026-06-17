/**
 * collect.ts - COLLECT state handler
 *
 * Pre-LLM pipeline: child questions, mail collection,
 * hint round, todo nudging, brief nudging,
 * role sequence validation.
 */

import { AgentState } from '../state-machine.js';
import type { MachineEnv, TurnVars, PassData, HandlerResult } from '../state-machine.js';
import { agentIO } from '../agent-io.js';
import { startWrapUp } from '../esc-wrap-up.js';
import { isVerbose } from '../../config.js';
import { loader } from '../../context/shared/loader.js';
import type { SequenceEvent } from '../../hook/sequence.js';

// Confusion threshold for hint generation
const CONFUSION_THRESHOLD = 10;
// Minimum message count before hint generation
const MIN_MESSAGES_FOR_HINT = 6;

/**
 * Generate a human-readable breakdown of confusion factors
 */
function generateBreakdown(
  confusionIndex: number,
  events: SequenceEvent[]
): string {
  const parts: string[] = [];

  // Count assistant turns (inferred from events - each turn has multiple tools)
  // Estimate turns by counting unique tool call batches
  const turnCount = Math.ceil(events.length / 3); // rough estimate
  if (turnCount > 0) {
    parts.push(`${turnCount} assistant turns`);
  }

  // Count errors — only match error/failed/fatal at the start of the result
  // to avoid false positives from normal file content containing these words.
  // Keep 'includes' for OS error codes (ENOENT, EACCES, EPERM) which are
  // specific identifiers that won't appear in file content.
  const errors = events.filter(e => {
    const result = e.result?.toLowerCase() || '';
    return result.startsWith('error:') || result.startsWith('error ') ||
           result.startsWith('fatal:') || result.startsWith('failed:') ||
           result.startsWith('failed ') ||
           result.includes('enoent') || result.includes('eacces') ||
           result.includes('eperm') || result.includes('permission denied');
  });
  if (errors.length > 0) {
    parts.push(`${errors.length} tool errors`);
  }

  // Count repeated actions (same tool in last 5 calls)
  const toolCounts = new Map<string, number>();
  for (const e of events) {
    toolCounts.set(e.tool, (toolCounts.get(e.tool) || 0) + 1);
  }
  const repeatedTools = Array.from(toolCounts.entries()).filter(([, count]) => count > 1);
  if (repeatedTools.length > 0) {
    parts.push(`${repeatedTools.length} repeated tools`);
  }

  return parts.length > 0 ? parts.join(', ') : 'No issues detected';
}

export async function handleCollect(
  env: MachineEnv,
  turn: TurnVars,
  _pass: PassData,
): Promise<HandlerResult> {
  const { triologue, ctx } = env;

  try {
    // 1. Handle pending questions from children
    await ctx.team.handlePendingQuestions();

    // 2. Collect mails — relies on auto-fix for TP-safe injection
    const mails = ctx.mail.collectMails();
    if (mails.length > 0) {
      const parts: string[] = [];

      // Standard mail format
      for (const mail of mails) {
        parts.push(`Mail from ${mail.from}: ${mail.title}\n${mail.content}`);
      }

      const mailContent = parts.join('\n\n---\n\n');

      if (agentIO.isNeglectedMode()) {
        triologue.note('URGENT', `user interrupted - wrap up quickly\n${mailContent}`);
      } else {
        triologue.note('MAIL', mailContent);
      }
    }

    // 3. Generate hint round if confusion threshold reached
    const confusionIndex = ctx.core.getConfusionIndex();
    const messageCount = triologue.getMessagesRaw().length;

    if (confusionIndex >= CONFUSION_THRESHOLD && messageCount >= MIN_MESSAGES_FOR_HINT) {
      // Use brief for hint round notification (user-facing)
      ctx.core.brief('info', 'loop', 'Generating hint...');
      // Get pending skills (skills with 'when' but no compiled condition)
      const pendingSkills = env.conditions.getPending();
      // Generate confusion breakdown from sequence events
      const breakdown = generateBreakdown(confusionIndex, env.sequence.getEvents());

      // Use escAware for ESC-interruptible hint generation
      const result = await ctx.core.escAware(
        async (abortController) => {
          return await triologue.generateHintRound(abortController, confusionIndex, breakdown, pendingSkills);
        },
        () => {
          // Start wrap-up when ESC is pressed during hint generation
          startWrapUp(triologue, loader.getToolsForScope(env.scope));
          return 'aborted' as const;
        }
      );
      
      // If aborted (ESC pressed), skip to PROMPT to show prompt immediately
      if (result === 'aborted') {
        return AgentState.PROMPT;
      }
      // Reset confusion after hint
      ctx.core.resetConfusionIndex();
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
        triologue.note('REMINDER', `Update your todos. ${ctx.todo.printTodoList()}`);
        turn.nextTodoNudge = 3;
      }
    }

    // 5. Brief nudging - remind agent to use brief tool
    turn.nextBriefNudge--;
    if (turn.nextBriefNudge <= 0) {
      triologue.note('REMINDER', 'Provide a brief status update using the brief tool. Example: brief("Working on X", 7)');
      turn.nextBriefNudge = 5;
    }

    // 6. Consume extracted keywords for proactive skill discovery.
    //    Matches extracted English keywords against loaded skill names and keywords.
    //    Injects a SKILLS note so the LLM knows which skills to load.
    if (turn.extractedKeywords.length > 0) {
      const keywords = turn.extractedKeywords;
      turn.extractedKeywords = []; // consume — only fire once per turn

      const allSkills = ctx.skill.listSkills();
      const matched = allSkills.filter(s => {
        const nameLower = s.name.toLowerCase();
        const kwLower = s.keywords.map(k => k.toLowerCase());
        return keywords.some(kw =>
          nameLower.includes(kw) ||
          kwLower.some(k => k.includes(kw) || kw.includes(k)),
        );
      });

      if (matched.length > 0) {
        const names = matched.map(s => s.name).join(', ');
        triologue.note('HINT',
          `Possible relevant skills: ${names}. Use skill_search(search="...") to discover, then skill_load(name="<exact_name>") to load.`);
      }
    }

    // 7. Log message count and token consumption in verbose mode
    if (isVerbose()) {
      const tokenCount = triologue.getTokenCount();
      const tokenThreshold = triologue.getTokenThreshold();
      const utilization = ((tokenCount / tokenThreshold) * 100).toFixed(1);
      ctx.core.verbose('collect', `${messageCount} messages, ${tokenCount}/${tokenThreshold} tokens (${utilization}%)`);
    }

    return AgentState.LLM;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    ctx.core.brief('error', 'collect', `COLLECT state error: ${errorMessage}`);
    return AgentState.PROMPT;
  }
}
