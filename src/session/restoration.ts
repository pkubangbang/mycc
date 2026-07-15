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
import { retryChat, MODEL } from '../engine/chat-provider.js';
import type { Message } from '../types.js';
import type { Session } from './types.js';
import { getTokenThreshold } from '../config.js';
import { estimateTokens } from '../utils/token.js';

/**
 * A summary pair: [user_message, assistant_message]
 */
export type SummaryPair = [Message, Message];

/**
 * Read messages from a JSONL triologue file
 */
function readTriologue(filePath: string): Message[] {
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
function fixOrphanedToolCalls(messages: Message[]): Message[] {
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

/**
 * Extract the teammate name from a child triologue file path.
 *
 * Filenames follow `triologue-{name}-{timestamp}.jsonl`, where `{name}` may
 * itself contain hyphens and `{timestamp}` is a unix-seconds number. The
 * regex anchors on the trailing `-{digits}.jsonl` so the greedy `.+`
 * captures the full name regardless of internal hyphens/digits.
 */
function extractTeammateFromPath(summaryPath: string): string {
  const normalizedPath = summaryPath.replace(/\\/g, '/');
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  const match = basename.match(/^triologue-(.+)-(\d+)\.jsonl$/);
  if (match) return match[1];
  const noExt = basename.replace(/\.jsonl$/, '');
  return noExt.startsWith('triologue-') ? noExt.slice('triologue-'.length) : basename;
}

/**
 * A "ready" event parsed from the lead transcript: a teammate reported its
 * triologue file path via a `[READY] triologue file: <path>` mail note.
 */
interface ReadyEvent {
  /** Teammate name (from the `name:` line, falling back to the filename). */
  name: string;
  /** Absolute path to the teammate's triologue JSONL. */
  triologuePath: string;
}

/**
 * Regex for the ready marker line. The teammate sends a mail whose body is:
 *   [READY] triologue file: <path>\nname: <name>
 * After collect.ts wraps it as a [MAIL] note, the content still contains the
 * `[READY] triologue file:` substring, so a single regex over message content
 * recovers the path. The `name:` line is optional (parsed separately).
 */
const READY_PATH_REGEX = /\[READY\] triologue file:\s*(.+)/;
const READY_NAME_REGEX = /^name:\s*(.+)/m;

/**
 * Scan lead messages for teammate "ready" events.
 *
 * Each ready event is a mail note (role 'user', content starting with `[MAIL]`)
 * containing a `[READY] triologue file: <path>` marker, emitted by the
 * teammate right after it becomes ready (see teammate-worker.ts).
 *
 * Returns events in transcript order. If a teammate reported ready more than
 * once (re-spawn), every occurrence is returned so the caller can decide how
 * to merge them.
 */
function scanReadyEvents(messages: Message[]): ReadyEvent[] {
  const events: ReadyEvent[] = [];
  for (const m of messages) {
    // Only user-role messages carry genuine [MAIL] notes containing READY
    // events. Tool results (role='tool') may contain source code that
    // coincidentally includes the `[READY] triologue file:` literal (e.g.
    // a read_file of teammate-worker.ts), producing false-positive matches
    // with garbage paths. Filter by role to eliminate them.
    if (m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    const pathMatch = m.content.match(READY_PATH_REGEX);
    if (!pathMatch) continue;
    const triologuePath = pathMatch[1].trim();
    const nameMatch = m.content.match(READY_NAME_REGEX);
    const name = nameMatch ? nameMatch[1].trim() : extractTeammateFromPath(triologuePath);
    events.push({ name, triologuePath });
  }
  return events;
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

/**
 * Summarize a single child triologue by path, with graceful degradation.
 *
 * - Missing file → placeholder summary (warn, don't throw).
 * - Empty/unreadable file → empty-conversation summary.
 *
 * @param name - Teammate name (for the narrative label).
 * @param triologuePath - Path to the child's triologue JSONL.
 * @returns A SummaryPair whose first element is the narrative-ready user message.
 */
async function summarizeChildByPath(name: string, triologuePath: string): Promise<SummaryPair> {
  if (!fs.existsSync(triologuePath)) {
    console.warn(chalk.yellow(`[restoration] Child triologue not found for ${name}, injecting placeholder: ${triologuePath}`));
    return [
      { role: 'user', content: `[${name} summary]\n[Teammate triologue file was missing or unreadable. No conversation summary available.]` },
      { role: 'assistant', content: 'OK' },
    ];
  }
  const triologue = readTriologue(triologuePath);
  const fixedTriologue = fixOrphanedToolCalls(triologue);
  const pair = await summarizeChildTriologue(fixedTriologue);
  // Re-label the narrative with the teammate name so the lead can attribute it.
  return [
    { role: 'user', content: `[${name} summary]\n${pair[0].content}` },
    pair[1],
  ];
}

/**
 * Summarize the lead triologue, injecting child summaries at "ready" events.
 *
 * Child summaries are NO LONGER pegged to tm_create tool results. Instead the
 * lead transcript is scanned for `[READY] triologue file: <path>` mail notes
 * (emitted by each teammate right after it becomes ready). At each ready note
 * the corresponding child triologue is read, summarized, and its narrative is
 * injected into the buffer — decoupled from tm_create positional alignment.
 *
 * tm_create tool results are now treated as ordinary messages: no positional
 * queue, no "missing summary" throw. A missing/empty child triologue degrades
 * to a placeholder for that one teammate only.
 *
 * Sessions recorded before the ready-mail mechanism existed will have no ready
 * events and therefore no child summaries injected — by design.
 */
async function summarizeLeadTriologue(messages: Message[]) {
  if (messages.length === 0) {
    return [
      { role: 'user', content: '[Empty conversation]' },
      { role: 'assistant', content: 'OK' },
    ] as SummaryPair;
  }

  // Pre-scan ready events so we can summarize children in parallel-ish order
  // and report progress. Summaries are keyed by the ready event index.
  const readyEvents = scanReadyEvents(messages);
  if (readyEvents.length > 0) {
    console.log(chalk.gray(`  Found ${readyEvents.length} teammate ready event(s) in lead transcript`));
  }

  // Summarize each child triologue up front (preserving order). Re-spawns of
  // the same name produce one entry per ready event.
  const childNarratives: Message[] = [];
  for (const ev of readyEvents) {
    const pair = await summarizeChildByPath(ev.name, ev.triologuePath);
    childNarratives.push(pair[0]);
  }

  // Build a quick lookup from the ready note's source message content to its
  // narrative, so we can inject the narrative right where the note appeared.
  // We match on the `[READY] triologue file: <path>` substring, which uniquely
  // identifies a ready event within the transcript.
  const narrativeByPath = new Map<string, Message>();
  for (let i = 0; i < readyEvents.length; i++) {
    narrativeByPath.set(readyEvents[i].triologuePath, childNarratives[i]);
  }

  // Buffer holds only Message[] — never pairs mixed in
  let buffer: Message[] = [];
  let tokens = 0;

  for (const m of messages) {
    // If this message is a ready note, inject the child's narrative summary
    // ahead of the note itself so the context reads naturally. Only
    // user-role [MAIL] notes are genuine ready events — tool results that
    // happen to contain the `[READY]` literal (e.g. a read_file of
    // teammate-worker.ts source) must NOT trigger injection here.
    if (m.role === 'user' && typeof m.content === 'string') {
      const pathMatch = m.content.match(READY_PATH_REGEX);
      if (pathMatch) {
        const p = pathMatch[1].trim();
        const narrative = narrativeByPath.get(p);
        if (narrative) {
          buffer.push(narrative);
          tokens += estimateTokens(narrative);
        }
      }
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
function generateDosq(session: Session, pair: SummaryPair): string {
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
 *
 * Degradation policy:
 * - Missing lead triologue → warn and return an empty-context pair. We do NOT
 *   throw: the caller (restoreSession) still wants a DOSQ so the user can
 *   write a fresh query and continue. Old/corrupt sessions are allowed to
 *   fail soft rather than aborting the whole app via process.exit.
 * - Missing child triologues are handled inside summarizeLeadTriologue via
 *   the READY-event scan (each missing child becomes a placeholder narrative
 *   for that one teammate only). Sessions recorded before the ready-mail
 *   mechanism simply have no READY events and thus no child summaries — by
 *   design ("do not cater for old sessions").
 */
export async function prepareRestoration(session: Session): Promise<{ pair: SummaryPair; dosqPath: string }> {
  console.log(chalk.blue('Restoring session...'));
  console.log(chalk.gray(`  Lead triologue: ${session.lead_triologue}`));
  console.log(chalk.gray(`  Child triologues (registered): ${session.child_triologues.length}`));

  // Lead triologue is the primary record. If it is missing, degrade to an
  // empty-context pair instead of throwing — the user can still continue.
  let combined: SummaryPair;
  if (!fs.existsSync(session.lead_triologue)) {
    console.warn(chalk.yellow(`[restoration] Lead triologue not found, restoring with empty context: ${session.lead_triologue}`));
    combined = [
      { role: 'user', content: '[Context from previous conversation]\n\nThe lead triologue file was missing or unreadable. No prior context could be restored.' },
      { role: 'assistant', content: 'Understood. Starting fresh since the prior session record is unavailable.' },
    ];
  } else {
    // Read lead triologue, fix orphaned tool calls. Child summaries are
    // discovered and injected via the READY-event scan inside
    // summarizeLeadTriologue — no separate child loop here.
    const rawLeadMessages = readTriologue(session.lead_triologue);
    const leadMessages = fixOrphanedToolCalls(rawLeadMessages);
    combined = await summarizeLeadTriologue(leadMessages);

    console.log(chalk.gray(`  Processed ${leadMessages.length} lead messages`));
  }

  // Generate DOSQ
  const dosqContent = generateDosq(session, combined);
  const dosqPath = writeDosq(dosqContent);

  console.log(chalk.gray(`  DOSQ written to: ${dosqPath}`));

  return { pair: combined, dosqPath };
}