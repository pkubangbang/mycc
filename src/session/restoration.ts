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
import { validateSession } from './index.js';

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
 * Estimate token count for messages (simple word-based approximation)
 */
function estimateTokens(messages: Message[]): number {
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

/**
 * Summarize messages with threshold-based buffer algorithm.
 *
 * Algorithm:
 * 1. Prepare empty buffer (Message[])
 * 2. Load buffer with messages until THRESHOLD
 * 3. Summarize buffer into a pair; extract pair's messages; empty buffer; push pair messages into buffer
 * 4. Repeat #2 until all messages processed
 * 5. Summarize final buffer → ONE pair
 *
 * Note: After summarization, the pair's user+assistant messages are pushed
 * back as individual Messages. This means subsequent iterations count
 * both messages for token estimation, which is more accurate but slightly
 * increases compaction frequency compared to the old mixed BufferItem approach.
 */
async function summarizeWithBuffer(
  messages: Message[],
  tokenThreshold: number = 50000
): Promise<SummaryPair> {
  if (messages.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'Understood.' },
    ];
  }

  // Buffer holds only Message[] — never pairs mixed in
  const buffer: Message[] = [];
  const remaining = [...messages];

  while (remaining.length > 0) {
    // Add messages until threshold
    while (remaining.length > 0 && estimateTokens(buffer) < tokenThreshold) {
      buffer.push(remaining.shift()!);
    }

    // Summarize buffer into a pair
    const pair = await summarizeMessages(buffer);

    // Empty buffer, push pair's messages back as individual Messages
    buffer.length = 0;
    buffer.push(pair[0], pair[1]);
  }

  // Final: summarize remaining buffer
  return summarizeMessages(buffer);
}

/**
 * Summarize a triologue file into a single pair.
 */
export async function summarizeTriologue(
  triologuePath: string,
  tokenThreshold: number = 50000
): Promise<SummaryPair> {
  const messages = readTriologue(triologuePath);
  return summarizeWithBuffer(messages, tokenThreshold);
}

/**
 * Summarize child triologues, returning a map of teammate name to summary pair
 */
export async function summarizeChildTriologues(
  childTriologues: string[],
  teammateNames: string[],
  tokenThreshold?: number
): Promise<Map<string, SummaryPair>> {
  const summaries = new Map<string, SummaryPair>();

  // Match triologue paths with teammate names
  for (let i = 0; i < childTriologues.length && i < teammateNames.length; i++) {
    const triologuePath = childTriologues[i];
    const teammateName = teammateNames[i];

    if (fs.existsSync(triologuePath)) {
      const pair = await summarizeTriologue(triologuePath, tokenThreshold);
      summaries.set(teammateName, pair);
    }
  }

  return summaries;
}

/**
 * Find tm_create tool calls in lead messages and extract teammate names.
 * Returns a map of teammate name → insertion index (after the tool result for that tm_create).
 */
function findTmCreatePositions(messages: Message[]): Map<string, number> {
  const positions = new Map<string, number>();
  const pendingCreates = new Map<string, string>(); // tool_call_id → teammateName

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Track tm_create calls in assistant messages
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls as ToolCall[]) {
        if (tc.function.name === 'tm_create') {
          const args = tc.function.arguments as Record<string, unknown>;
          const name = String(args.name || args.__name || '');
          if (name) {
            pendingCreates.set(tc.id, name);
          }
        }
      }
    }

    // When we see the tool result for a tm_create, mark the insertion point
    if (msg.role === 'tool' && msg.tool_call_id) {
      const teammateName = pendingCreates.get(msg.tool_call_id);
      if (teammateName) {
        // Insert after this tool result
        positions.set(teammateName, i + 1);
        pendingCreates.delete(msg.tool_call_id);
      }
    }
  }

  return positions;
}

/**
 * Inject child summaries into lead messages at tm_create positions.
 * Each child summary is inserted as a single user message (no noise "Understood" message).
 * Children whose tm_create position is not found are appended at the end.
 *
 * Note: positions are based on original leadMessages indices. The loop iterates
 * over leadMessages (not result), so positions map correctly even though result
 * grows as children are inserted — the i+1 check matches original indices.
 */
function injectChildSummaries(
  leadMessages: Message[],
  childSummaries: Map<string, SummaryPair>
): Message[] {
  const positions = findTmCreatePositions(leadMessages);
  const injected = new Set<string>();

  // Build result by scanning lead messages and inserting child summaries at positions
  const result: Message[] = [];

  for (let i = 0; i < leadMessages.length; i++) {
    result.push(leadMessages[i]);

    // Check if any child should be inserted at this position
    for (const [teammateName, pair] of childSummaries) {
      if (positions.get(teammateName) === i + 1 && !injected.has(teammateName)) {
        result.push({
          role: 'user',
          content: `[Teammate ${teammateName} summary]\n${pair[0].content}`,
        });
        injected.add(teammateName);
      }
    }
  }

  // Append any remaining children whose positions were not found
  for (const [teammateName, pair] of childSummaries) {
    if (!injected.has(teammateName)) {
      result.push({
        role: 'user',
        content: `[Teammate ${teammateName} summary]\n${pair[0].content}`,
      });
    }
  }

  return result;
}

/**
 * Generate DOSQ markdown content from a single summary pair.
 *
 * The DOSQ has three sections:
 * 1. Header + Summary — visible context the user can review/edit
 * 2. Instructions — wrapped in HTML comment so they're stripped during parsing
 * 3. Query area — after the final --- separator, where the user writes their first query
 */
export function generateDosq(session: Session, pair: SummaryPair): string {
  const lines: string[] = [
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
    '<!--',
    '  INSTRUCTIONS',
    '  ============',
    '  Edit the Session Summary section above to add or modify context.',
    '  Write your first query for the restored session below the last --- separator.',
    '  Everything inside this HTML comment block will be ignored.',
    '-->',
    '',
    '---',
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
 * 1. All HTML comments (<!-- ... -->) are stripped — this removes the instructions block
 * 2. The query is the content after the last '---' separator
 * 3. Whitespace is trimmed from the result
 * 4. If the result is empty, a default continuation prompt is returned
 *
 * This mirrors git's approach to commit messages (comments stripped, content
 * after separator is the payload).
 */
export function extractFirstQuery(dosqContent: string): string {
  // Remove all HTML comments
  let content = dosqContent.replace(/<!--[\s\S]*?-->/g, '');

  // Find the content after the last '---' separator
  const lastSeparator = content.lastIndexOf('---');
  if (lastSeparator !== -1) {
    content = content.slice(lastSeparator + 3);
  }

  const query = content.trim();
  if (!query) {
    return 'Continue from where we left off.';
  }
  return query;
}

/**
 * Full session restoration workflow.
 * Returns a single summary pair and DOSQ path.
 */
export async function prepareRestoration(
  session: Session,
  tokenThreshold?: number
): Promise<{ pair: SummaryPair; dosqPath: string }> {
  // Validate session files exist
  const validation = validateSession(session);
  if (!validation.valid) {
    throw new Error(`Session files missing: ${validation.missingFiles.join(', ')}`);
  }

  console.log(chalk.blue('Restoring session...'));
  console.log(chalk.gray(`  Lead triologue: ${session.lead_triologue}`));
  console.log(chalk.gray(`  Child triologues: ${session.child_triologues.length}`));

  // Summarize child triologues
  const childSummaries = await summarizeChildTriologues(
    session.child_triologues,
    session.teammates,
    tokenThreshold
  );

  console.log(chalk.gray(`  Summarized ${childSummaries.size} child triologues`));

  // Read lead triologue and inject child summaries at tm_create positions
  const leadMessages = readTriologue(session.lead_triologue);
  const combinedMessages = injectChildSummaries(leadMessages, childSummaries);

  console.log(chalk.gray(`  Combined ${combinedMessages.length} messages (lead + child summaries)`));

  // Summarize combined messages into a single pair
  const pair = await summarizeWithBuffer(combinedMessages, tokenThreshold ?? 50000);

  console.log(chalk.gray('  Generated summary pair'));

  // Generate DOSQ
  const dosqContent = generateDosq(session, pair);
  const dosqPath = writeDosq(dosqContent);

  console.log(chalk.gray(`  DOSQ written to: ${dosqPath}`));

  return { pair, dosqPath };
}