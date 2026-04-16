/**
 * agent-prompts.ts - System prompt building utilities
 */

import type { AgentContext } from '../types.js';

/**
 * Build system prompt based on agent context and identity
 */
export function buildSystemPrompt(
  ctx: AgentContext,
  identity?: { name: string; role: string }
): string {
  const workDir = ctx.core.getWorkDir();
  const skills = ctx.skill.printSkills();

  // Current date/time for context (helps with time-sensitive queries like web search)
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();

  // Common suffix for all prompts
  const common = [
    '## Calendar',
    `Current date: ${currentDate} (year: ${currentYear})`,
    '## Skills',
    `${skills}`,
    '',
    '## Output Behavior',
    'Respond concisely - do not repeat what tools have already displayed.',
  ].join('\n');

  // For child process, include identity and collaboration guidance
  if (identity) {
    return [
      `You are ${identity.name}, a specialized agent working as part of a team, created by the "lead".`,
      `Your role is ${identity.role}. You are working at ${workDir}.`,
      'Use skills to access specialized knowledge.',

      'You have only 3 ways to interact with others:',
      '1. use mail_to tool to inform other teammates.',
      '2. use question tool to pause and get input from the user.',
      '3. use brief tool to output debugging info to the user.',
      // to prevent mail flood.
      'REMEMBER: you cannot use the same type of tool from the above 3 tools consecutively.',

      'When you choose not to use any tool (thus finishing the task), your ending words will be mailed to "lead" automatically.',

      'When you feel lost about the context, send mail to "lead".',
      common,
    ].join('\n');
  }

  // Main process (lead agent) system prompt
  const hasTeam = ctx.team.printTeam() !== 'No teammates.';

  if (hasTeam) {
    return [
      `You are the lead of a coding agent team at ${workDir}.`,
      `Your role: coordinate teammates, collect results, and ensure task completion.`,

      `## Team Workflow`,
      `1. Create teammates with tm_create (each gets a role and instructions)`,
      `2. Write kickoff todos with todo_write to plan the work`,
      `3. Distribute tasks using issue_create - teammates will claim tasks automatically.`,
      `4. Collect results from mailbox and integrate them`,

      `## Communication`,
      `You have access to the issue system to coordinate tasks`,
      `Also you can send mails to the teammates. Send mails only if necessary, and keep the content actionable.`,
      `If you find yourself waiting for the reply from the teammates, do not use tools in this round.`,
      `Remember that the teammates can directly ask questions to the user, and you will get a copy of the chat.`,
      `If you want to ask me questions, do not use any tool, just leave your question as the reply.`,

      `## Special Rules`,
      `- You must ask for grant BEFORE "git commit" with no exception. The permission is only valid for one commit, for the next commit you MUST ask for grant again.`,
      common,
    ].join('\n');
  }

  return [
    `You are a coding agent at ${workDir}.`,
    `Use tools to finish tasks. Use skills to access specialized knowledge.`,
    `## Task Management`,
    `Use issue_* for complex tasks (divide and conquer), todo_* for simple tracking.`,
    `## Team Mode`,
    `If the task would benefit from parallel work, create teammates with tm_create to form a team.`,
    `## Rules`,
    `- You must ask for grant BEFORE "git commit" with no exception. The permission is only valid for one commit, for the next commit you MUST ask for grant again.`,
    common,
  ].join('\n');
}