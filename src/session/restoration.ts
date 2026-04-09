/**
 * restoration.ts - Session restoration logic
 *
 * Handles summarizing triologues into "pairs" and generating DOSQ.
 * A "pair" is a 2-tuple: [user_message, assistant_message].
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { retryChat, MODEL } from '../ollama.js';
import type { Message } from '../types.js';
import type { Session } from './types.js';
import { validateSession } from './index.js';

/**
 * A summary pair: [user_message, assistant_message]
 */
export type SummaryPair = [Message, Message];

/**
 * Buffer item can be a Message or a SummaryPair
 */
type BufferItem = Message | SummaryPair;

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
 * Estimate token count for buffer items (simple word-based approximation)
 */
function estimateTokens(items: BufferItem[]): number {
  let total = 0;
  for (const item of items) {
    if (Array.isArray(item)) {
      // SummaryPair: estimate from user message content
      total += item[0].content.split(/\s+/).length;
    } else {
      // Message
      if (item.content) {
        total += item.content.split(/\s+/).length;
      }
      if (item.tool_calls) {
        for (const tc of item.tool_calls) {
          total += JSON.stringify(tc.function.arguments).split(/\s+/).length;
        }
      }
    }
  }
  return total;
}

/**
 * Convert buffer items to text for LLM summarization
 */
function bufferToText(items: BufferItem[]): string {
  return items.map(item => {
    if (Array.isArray(item)) {
      // SummaryPair
      return `[Summary]\n${item[0].content}`;
    }
    // Message
    return JSON.stringify(item);
  }).join('\n\n');
}

/**
 * Summarize buffer items into a single pair using LLM
 */
async function summarizeBuffer(items: BufferItem[]): Promise<SummaryPair> {
  if (items.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'Understood.' },
    ];
  }

  // If single item and it's already a pair, return it
  if (items.length === 1 && Array.isArray(items[0])) {
    return items[0] as SummaryPair;
  }

  const text = bufferToText(items);

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
 * Summarize a triologue file into a single pair using recursive buffer algorithm.
 *
 * Algorithm:
 * 1. Given messages list and TOKEN_THRESHOLD
 * 2. Prepare empty buffer
 * 3. Load buffer with messages until THRESHOLD
 * 4. Summarize buffer into a pair; empty buffer; push pair into buffer
 * 5. Repeat #3 until all messages processed
 * 6. Summarize final buffer → ONE pair
 */
export async function summarizeTriologue(
  triologuePath: string,
  tokenThreshold: number = 50000
): Promise<SummaryPair> {
  const messages = readTriologue(triologuePath);

  if (messages.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'Understood.' },
    ];
  }

  // Buffer can hold Messages or SummaryPairs
  const buffer: BufferItem[] = [];
  const remaining = [...messages];

  while (remaining.length > 0) {
    // Add messages until threshold
    while (remaining.length > 0 && estimateTokens(buffer) < tokenThreshold) {
      buffer.push(remaining.shift()!);
    }

    // Summarize buffer into a pair
    const pair = await summarizeBuffer(buffer);

    // Empty buffer, push pair
    buffer.length = 0;
    buffer.push(pair);
  }

  // Final: summarize remaining buffer
  return summarizeBuffer(buffer);
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
 * Inject child summaries at tm_create positions in lead triologue pair.
 *
 * Returns array of pairs: [lead, child1, child2, ...]
 */
export function injectChildSummaries(
  leadPair: SummaryPair,
  childSummaries: Map<string, SummaryPair>
): SummaryPair[] {
  const result: SummaryPair[] = [leadPair];

  // Check if the lead summary mentions tm_create
  const content = leadPair[0].content;

  // Find all tm_create calls and their teammate names
  const tmCreateRegex = /tm_create.*?name[:\s]+['"]?(\w+)['"]?/gi;
  let match;

  while ((match = tmCreateRegex.exec(content)) !== null) {
    const teammateName = match[1];
    const childSummary = childSummaries.get(teammateName);
    if (childSummary) {
      result.push([
        { role: 'user', content: `[Teammate ${teammateName} summary]\n${childSummary[0].content}` },
        childSummary[1],
      ]);
    }
  }

  return result;
}

/**
 * Process lead triologue with child summaries injected
 */
export async function processLeadTriologue(
  session: Session,
  childSummaries: Map<string, SummaryPair>,
  tokenThreshold?: number
): Promise<SummaryPair[]> {
  // Summarize lead triologue (one pair)
  const leadPair = await summarizeTriologue(session.lead_triologue, tokenThreshold);

  // Inject child summaries at tm_create positions
  return injectChildSummaries(leadPair, childSummaries);
}

/**
 * Generate DOSQ markdown content
 */
export function generateDosq(session: Session, summaryPairs: SummaryPair[]): string {
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
  ];

  // Add summary pairs
  for (let i = 0; i < summaryPairs.length; i++) {
    const pair = summaryPairs[i];
    lines.push(`### Segment ${i + 1}`);
    lines.push('');
    lines.push('**Context:**');
    lines.push(pair[0].content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Add instructions for user
  lines.push('## Instructions');
  lines.push('');
  lines.push('Edit this document to add any additional context before continuing.');
  lines.push('Save and close to start the restored session.');
  lines.push('');
  lines.push('---');
  lines.push('');

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
 * Removes all HTML comments (like git does with commit messages).
 */
export function extractFirstQuery(dosqContent: string): string {
  // Remove all HTML comments
  let content = dosqContent.replace(/<!--[\s\S]*?-->/g, '');

  // Find the content after the last '---' separator
  const lastSeparator = content.lastIndexOf('---');
  if (lastSeparator !== -1) {
    content = content.slice(lastSeparator + 3);
  }

  return content.trim();
}

/**
 * Full session restoration workflow
 * Returns summary pairs and DOSQ path
 */
export async function prepareRestoration(
  session: Session,
  tokenThreshold?: number
): Promise<{ pairs: SummaryPair[]; dosqPath: string }> {
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

  // Process lead triologue with child summaries injected
  const pairs = await processLeadTriologue(session, childSummaries, tokenThreshold);

  console.log(chalk.gray(`  Generated ${pairs.length} summary pairs`));

  // Generate DOSQ
  const dosqContent = generateDosq(session, pairs);
  const dosqPath = writeDosq(dosqContent);

  console.log(chalk.gray(`  DOSQ written to: ${dosqPath}`));

  return { pairs, dosqPath };
}