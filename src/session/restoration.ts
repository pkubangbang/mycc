/**
 * restoration.ts - Session restoration logic
 *
 * Handles summarizing triologues into a "pair" and generating DOSQ.
 * A "pair" is a 2-tuple: [user_message, assistant_message].
 *
 * Internal processing uses only Message[] — the pair concept appears
 * only as the final output, never mixed into intermediate buffers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { retryChat, MODEL } from '../ollama.js';
import type { Message, ToolCall } from '../types.js';
import type { Session } from './types.js';
import { getTokenThreshold } from '../config.js';

/**
 * A summary pair: [user_message, assistant_message]
 */
export type SummaryPair = [Message, Message];

/**
 * Read messages from a JSONL triologue file
 */
export function readTriologue(filePath: string): Message[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const messages: Message[] = [];

  for (const line of content.trim().split('\n')) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        // Skip malformed lines
      }
    }
  }

  return messages;
}

/**
 * Detect and fix orphaned tool calls in a triologue.
 *
 * Orphaned tool calls happen when a session is interrupted mid-execution:
 * - Last message is assistant with tool_calls
 * - No corresponding tool results follow
 *
 * This function:
 * 1. Tracks pending tool calls through the message sequence
 * 2. Detects remaining pending calls at the end
 * 3. Injects synthetic "interrupted" tool results for them
 *
 * @param messages - Messages from triologue
 * @returns Messages with orphaned tool calls fixed
 */
export function fixOrphanedToolCalls(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  // Track pending tool calls: id -> {id, function: {name, arguments}}
  // Note: ollama's ToolCall type doesn't have 'id', but runtime data does
  type ToolCallWithId = { id: string; function: { name: string; arguments: Record<string, unknown> } };
  const pendingCalls = new Map<string, ToolCallWithId>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      // Add new tool calls to pending (cast to include id)
      for (const tc of msg.tool_calls as ToolCallWithId[]) {
        if (tc.id) {
          pendingCalls.set(tc.id, tc);
        }
      }
    } else if (msg.role === 'tool') {
      // Remove from pending when we see a result
      if (msg.tool_call_id) {
        pendingCalls.delete(msg.tool_call_id);
      }
    }
  }

  // If no pending calls remain, no fix needed
  if (pendingCalls.size === 0) {
    return messages;
  }

  // Found orphaned tool calls - inject synthetic results
  const fixed = [...messages];
  console.log(chalk.yellow(`[restoration] Found ${pendingCalls.size} orphaned tool call(s) - adding interrupt markers`));

  for (const [id, tc] of pendingCalls) {
    const toolName = tc.function.name;
    const args = tc.function.arguments ?? {};
    const command = args.command ?? args.path ?? args.name ?? '';

    console.log(chalk.gray(`  - ${toolName}${command ? `: ${String(command).slice(0, 50)}` : ''}`));

    fixed.push({
      role: 'tool',
      tool_name: toolName,
      tool_call_id: id,
      content: `[INTERRUPTED] This tool call was interrupted before completion. The session was likely terminated during execution. Consider retrying if needed.`,
    });
  }

  // Add assistant acknowledgment
  fixed.push({
    role: 'assistant',
    content: 'I was interrupted during tool execution. The interrupted tool call(s) have been marked. How would you like to proceed?',
  });

  return fixed;
}

function estimateTokens(message: Message): number {
  let total = 0;
  if (message.content) {
    total += message.content.split(/\s+/).length;
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      total += JSON.stringify(tc.function.arguments).split(/\s+/).length;
    }
  }

  return total;
}

/**
 * Verify that teammate name matches the expected path
 */
function ensureSameTeammate(teammate: string, summaryPath: string): void {
  // Extract teammate name from summary path (e.g., "teammate-foo-123" from path)
  const pathMatch = summaryPath.match(/\.mycc\/transcripts\/([^/]+)-triologue\.jsonl/);
  const pathTeammate = pathMatch ? pathMatch[1] : summaryPath;

  if (!pathTeammate.startsWith(teammate)) {
    throw new Error(`Teammate mismatch: expected "${teammate}" but summary path contains "${pathTeammate}"`);
  }
}

/**
 * Create a narrative summary message for a child agent's conversation
 */
function createNarrativeSummary(teammate: string, summary: Message): Message {
  return {
    role: 'user',
    content: `[${teammate} summary]\n${summary.content}`,
  };
}

/**
 * Convert messages to text for LLM summarization
 */
function messagesToText(messages: Message[]): string {
  return messages
    .map((msg) => JSON.stringify(msg))
    .join('\n\n');
}

/**
 * Summarize messages into a single pair using LLM.
 */
async function summarizeMessages(messages: Message[]): Promise<SummaryPair> {
  if (messages.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'Understood.' },
    ];
  }

  const text = messagesToText(messages);

  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content:
          `Summarize this conversation for continuity. Include:\n` +
          `1) What was discussed or accomplished\n` +
          `2) Key decisions or findings\n` +
          `3) Current state and next steps\n\n` +
          `Be concise but preserve critical details.\n\n${text}`,
      },
    ],
  });

  const summary = response.message.content || '(no summary)';

  return [
    { role: 'user', content: `[Context from previous conversation]\n\n${summary}` },
    { role: 'assistant', content: 'Understood. I have the context from the summary.' },
  ];
}

async function summarizeChildTriologue(messages: Message[]): Promise<SummaryPair> {
  if (messages.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'OK' },
    ];
  }

  // Buffer holds only Message[] — never pairs mixed in
  let buffer: Message[] = [];
  let tokens = 0;
  for (const m of messages) {
    buffer.push(m);
    tokens += estimateTokens(m);
    if (tokens > getTokenThreshold()) {
      buffer = await summarizeMessages(buffer);
    }
  }

  // Final: summarize remaining buffer
  return summarizeMessages(buffer);
}

async function summarizeLeadTriologue(messages: Message[], childSummaries: { path: string, summary: Message }[]) {
  if (messages.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'OK' },
    ] as SummaryPair;
  }

  // Buffer holds only Message[] — never pairs mixed in
  let buffer: Message[] = [];
  let tokens = 0;
  const summaries = [...childSummaries];

  // tool_call_id -> teammate name
  const pendingTmCreateCall: Record<string, string> = {};
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) {
      for (const toolCall of m.tool_calls) {
        if (toolCall.function.name === 'tm_create') {
          const args = toolCall.function.arguments ?? {};
          pendingTmCreateCall[(toolCall as ToolCall).id] = args.name || 'unknown';
        }
      }
    }

    if (m.tool_name === 'tm_create') {
      const teammate = pendingTmCreateCall[m.tool_call_id || 'unknown'];
      if (!teammate) {
        throw new Error(`no corresponding teammate found for tool call ${m.tool_call_id}`)
      }

      // Check if tm_create was successful (response should not contain "Error:")
      const responseContent = m.content || '';
      const isFailed = responseContent.startsWith('Error:') || responseContent.includes('already exists');

      if (isFailed) {
        // tm_create failed - no triologue to inject, just skip
        // The teammate was not spawned, so there's no summary to inject
        delete pendingTmCreateCall[m.tool_call_id || 'unknown'];
        continue;
      }

      const s = summaries.shift();

      if (!s) {
        throw new Error(`missing summary for teammate ${teammate}`);
      }

      ensureSameTeammate(teammate, s.path);

      // inject the user narration of child's summary
      const narration = createNarrativeSummary(teammate, s.summary);
      buffer.push(narration);
      tokens += estimateTokens(narration);
    }


    buffer.push(m);
    tokens += estimateTokens(m);

    if (tokens > getTokenThreshold()) {
      buffer = await summarizeMessages(buffer);
    }
  }

  // Final: summarize remaining buffer
  return summarizeMessages(buffer);
}


/**
 * Generate DOSQ markdown content from a single summary pair.
 *
 * The DOSQ wraps all session context in an HTML comment block, leaving only
 * the query area visible for editing. This ensures the LLM doesn't see the
 * metadata/summary unless the user explicitly modifies it.
 *
 * Format:
 * <!--
 *   [Session metadata and summary - ignored during parsing]
 * -->
 * [User's query - extracted after stripping HTML comments]
 */
export function generateDosq(session: Session, pair: SummaryPair): string {
  const lines: string[] = [
    '<!--',
    `# Session: ${session.id.slice(0, 7)}`,
    '',
    `**Created:** ${session.create_time}`,
    `**Project:** ${session.project_dir}`,
    `**Teammates:** ${session.teammates.length > 0 ? session.teammates.join(', ') : 'none'}`,
    '',
    '---',
    '',
    '## Session Summary',
    '',
    '**Context:**',
    pair[0].content,
    '',
    '---',
    '',
    'INSTRUCTIONS',
    '============',
    'The session context above is wrapped in an HTML comment block.',
    'It will be included when the session is restored.',
    'Edit it if you need to add or modify context.',
    'Write your first query below (after the HTML comment ends).',
    '-->',
    '',
  ];

  return lines.join('\n');
}

/**
 * Write DOSQ to temporary file and return path
 */
export function writeDosq(content: string): string {
  const tempDir = path.join(os.tmpdir(), 'mycc');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const dosqPath = path.join(tempDir, `dosq-${timestamp}.md`);
  fs.writeFileSync(dosqPath, content, 'utf-8');

  return dosqPath;
}

/**
 * Read DOSQ from file after user edits
 */
export function readDosq(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Extract first query from DOSQ content.
 *
 * Parsing rules:
 * 1. Strip all HTML comments (the summary context is for user reference only)
 * 2. Return trimmed remaining content or default continuation prompt
 *
 * Note: The session context is already loaded via triologue.loadRestoration(pair).
 * The DOSQ summary in comments is for user reference/editing. If user edits the
 * summary, they should include relevant changes in their query area.
 */
export function extractFirstQuery(dosqContent: string): string {
  // Remove all HTML comments (summary is already loaded in pair)
  const contentWithoutComments = dosqContent.replace(/<!--[\s\S]*?-->/g, '');

  // Return remaining content (user's query) or default
  const query = contentWithoutComments.trim();
  return query || 'Continue from where we left off.';
}

/**
 * Full session restoration workflow.
 * Returns a single summary pair and DOSQ path.
 */
export async function prepareRestoration(session: Session): Promise<{ pair: SummaryPair; dosqPath: string }> {
  // Validate lead triologue exists (required)
  if (!fs.existsSync(session.lead_triologue)) {
    throw new Error(`Lead triologue not found: ${session.lead_triologue}`);
  }

  console.log(chalk.blue('Restoring session...'));
  console.log(chalk.gray(`  Lead triologue: ${session.lead_triologue}`));
  console.log(chalk.gray(`  Child triologues: ${session.child_triologues.length}`));

  // Summarize child triologues - skip missing files
  const childSummaries: { path: string, summary: Message }[] = [];
  for (const path of session.child_triologues) {
    if (!fs.existsSync(path)) {
      console.warn(chalk.yellow(`[restoration] Child triologue not found, skipping: ${path}`));
      continue;
    }
    const triologue = readTriologue(path);
    const fixedTriologue = fixOrphanedToolCalls(triologue);
    const pair = await summarizeChildTriologue(fixedTriologue);
    childSummaries.push({
      path,
      summary: pair[0]
    });
  }

  console.log(chalk.gray(`  Summarized ${childSummaries.length} child triologues`));

  // Read lead triologue, fix orphaned tool calls, and inject child summaries at tm_create positions
  const rawLeadMessages = readTriologue(session.lead_triologue);
  const leadMessages = fixOrphanedToolCalls(rawLeadMessages);
  const combined = await summarizeLeadTriologue(leadMessages, childSummaries);

  console.log(chalk.gray(`  Combined ${leadMessages.length + childSummaries.length} messages (lead + child summaries)`));


  // Generate DOSQ
  const dosqContent = generateDosq(session, combined);
  const dosqPath = writeDosq(dosqContent);

  console.log(chalk.gray(`  DOSQ written to: ${dosqPath}`));

  return { pair: combined, dosqPath };
}