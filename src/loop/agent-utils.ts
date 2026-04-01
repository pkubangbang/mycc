/**
 * agent-utils.ts - Shared utilities for agent loop and worker
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Message } from 'ollama';
import { ollama, MODEL } from '../ollama.js';
import { getMyccDir, ensureDirs } from '../context/db.js';
import type { AgentContext } from '../types.js';

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

  const response = await ollama.chat({
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
 * Create identity block for child process system prompt
 */
export function makeIdentityBlock(name: string, role: string, workDir: string): string {
  return `[IDENTITY]
Name: ${name}
Role: ${role}
Working Directory: ${workDir}
[/IDENTITY]`;
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

  // For child process, include identity and collaboration guidance
  if (identity) {
    return [
      'You are a specialized agent working as part of a team.',
      '',
      'Claim tasks proactively and collaborate with teammates through mail.',
      '',
      'Use skills to access specialized knowledge.',
      '',
      'Use question tools to ask question to the user,',
      'use brief tools to report your progress.',
      '',
      'When you feel lost about the context, send mail to "lead".',
      '',
      makeIdentityBlock(identity.name, identity.role, workDir),
      '',
      `Skills: ${skills}`,
    ].join('\n');
  }

  // Main process (lead agent) system prompt
  const team = ctx.team?.printTeam() || 'No teammates.';
  const hasTeam = team !== 'No teammates.';

  if (hasTeam) {
    return [
      `You are the lead of a coding agent team at ${workDir}.`,
      `You spawn teammates, create issues and collect results.`,
      `Use tools to finish tasks. Use skills to access specialized knowledge.`,
      `Read README.md or CLAUDE.md first if you feel lost about the context.`,
      `You must ask for grant BEFORE "git commit" with no exception.`,
      `Skills: ${skills}`
    ].join('\n');
  } else {
    return [
      `You are a coding agent at ${workDir}.`,
      `Use tools to finish tasks. Use skills to access specialized knowledge.`,
      `Consider using issue_* to divide and conquor complex tasks, using todo_* for simple task tracking.`,
      `You must ask for grant BEFORE "git commit" with no exception.`,
      `Skills: ${skills}`
    ].join('\n');
  }
}