/**
 * agent-utils.ts - Shared utilities for agent loop and worker
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Message, AgentContext } from '../types.js';
import { retryChat, MODEL } from '../ollama.js';
import { getMyccDir, ensureDirs } from '../context/db.js';

export const TOKEN_THRESHOLD = 50000;

/**
 * Estimate token count (rough approximation)
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      total += msg.content.split(/\s+/).length;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += JSON.stringify(tc.function.arguments).split(/\s+/).length;
      }
    }
  }
  return total;
}

/**
 * Micro-compact: collapse consecutive tool results
 */
export function microCompact(messages: Message[]): void {
  // Find consecutive tool messages and combine them
  const newMessages: Message[] = [];
  let pendingTools: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      pendingTools.push(msg);
    } else {
      if (pendingTools.length > 0) {
        // Combine pending tools into a single user message
        const combined = pendingTools.map((m) => m.content).join('\n---\n');
        newMessages.push({ role: 'user', content: `Previous tool results:\n${combined}` });
        pendingTools = [];
      }
      newMessages.push(msg);
    }
  }

  // Handle any remaining pending tools
  if (pendingTools.length > 0) {
    const combined = pendingTools.map((m) => m.content).join('\n---\n');
    newMessages.push({ role: 'user', content: `Previous tool results:\n${combined}` });
  }

  // Modify in place
  messages.length = 0;
  messages.push(...newMessages);
}

/**
 * Auto-compact: save transcript and summarize old messages using LLM
 */
export async function autoCompact(messages: Message[]): Promise<Message[]> {
  // Ensure transcript directory exists
  ensureDirs();
  const transcriptDir = path.join(getMyccDir(), 'transcripts');
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  // Save full transcript to disk
  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(transcriptDir, `transcript_${timestamp}.jsonl`);

  const writeStream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    writeStream.write(JSON.stringify(msg) + '\n');
  }
  writeStream.end();

  console.log(`[transcript saved: ${transcriptPath}]`);

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(0, 80000);

  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content:
          'Summarize this conversation for continuity. Include: ' +
          '1) What was accomplished, 2) Current state, 3) Key decisions made. ' +
          'Be concise but preserve critical details.\n\n' +
          conversationText,
      },
    ],
  });

  const summary = response.message.content || '(no summary)';

  return [
    {
      role: 'user',
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the context from the summary. Continuing.',
    },
  ];
}

/**
 * Build system prompt
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
      'You are a specialized agent working as part of a team, created by the team lead.',
      'Use skills to access specialized knowledge.',
      'use brief tool to output debugging info to the user,',
      'use question tool to send query and get input from the user,',
      'use mail_to tools to communicate with other teammates. DO NOT MIX THEM UP.',
      
      'When you feel lost about the context, send mail to "lead".',
      '',
      '[IDENTITY]',
      `Name: ${identity.name}`,
      `Role: ${identity.role}`,
      `Working Directory: ${workDir}`,
      '[/IDENTITY]',
      common,
    ].join('\n');
  }

  // Main process (lead agent) system prompt
  const hasTeam = (ctx.team?.printTeam() || 'No teammates.') !== 'No teammates.';

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
      `Remember that the teammates can directly ask questions to the user, and you will get a copy of the chat.`,
      `If you want to ask me questions, do not use any tool, just leave your question as the reply.`,

      `## Rules`,
      `- Ask for grant BEFORE "git commit" with no exception.`,
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
    `- Ask for grant BEFORE "git commit" with no exception.`,
    common,
  ].join('\n');
}