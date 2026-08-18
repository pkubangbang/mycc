/**
 * serve-history.ts - chat-history reconstruction for the /history endpoint
 *
 * Extracted from ServeHub as pure functions that take their data sources
 * (transcript path, user-log path, in-memory messageLog) as parameters,
 * so the merging logic can be reasoned about and tested without importing
 * the heavy serve-hub.ts module graph (Express + Vite + agent-io).
 *
 * History is reconstructed from TWO durable sources, merged by timestamp:
 *
 * 1. The triologue JSONL transcript (transcriptPath) — assistant/tool/system
 *    turns. role:'user' entries are SKIPPED because they are polluted with
 *    injected system notes ([REMINDER]/[HINT]/[WRAP_UP] etc.) that must NOT
 *    render as right-side user bubbles.
 *
 * 2. The user-log JSONL (userLogPath) — real user submissions only (prompt
 *    queries + steering notes), written via appendUserLog(). These are the
 *    genuine right-side user bubbles.
 *
 * Both sources carry a `timestamp` field, so they merge into the correct
 * chronological order. The in-memory messageLog (intermediate
 * brief/log/warn/error + cards) is appended after — it already carries
 * timestamps, so it sorts into the merged sequence too.
 */
import * as fs from 'fs';
import { stripAnsi } from './serve-utils.js';
import type { LogEntry } from './serve-types.js';

const MAX_LOG_SIZE = 1000;

/** Map a triologue Message role to a WebUI LogEntry type. */
export function roleToType(role: string | undefined): string {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'result';
    case 'tool': return 'log';
    case 'system': return 'system';
    default: return 'log';
  }
}

/**
 * Map a triologue Message role to a WebUI display label (shown as
 * [HH:MM:SS] [label] in the UI, mirroring the terminal brief header).
 */
export function roleToLabel(role: string | undefined): string | undefined {
  switch (role) {
    case 'assistant': return 'assistant';
    case 'user': return undefined;   // user bubbles already align right
    default: return undefined;       // tool/system logs: no special label
  }
}

/**
 * Read the user-log JSONL (real user submissions) and map each entry to a
 * 'user'-type LogEntry (right-side bubble). Returns an empty array if the
 * user log path is unset or the file is missing/unreadable.
 *
 * Each user-log line is `{ type: 'user', content, kind, timestamp }`. The
 * `kind` field ('prompt' | 'steer') is informational only — both kinds
 * render identically as right-side user bubbles.
 */
export function readUserLog(userLogPath: string | null): LogEntry[] {
  if (!userLogPath) return [];
  try {
    const raw = fs.readFileSync(userLogPath, 'utf-8');
    const entries: LogEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: { content?: string; timestamp?: number };
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed lines
      }
      if (entry.content === undefined || entry.content === null || entry.content === '') continue;
      const logEntry: LogEntry = { type: 'user', content: stripAnsi(String(entry.content)) };
      if (typeof entry.timestamp === 'number') logEntry.timestamp = entry.timestamp;
      entries.push(logEntry);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Reconstruct the full chat history for the /history endpoint.
 *
 * @param transcriptPath - durable triologue JSONL path (assistant/tool/system)
 * @param userLogPath    - durable user-log JSONL path (real user submissions)
 * @param messageLog     - in-memory log (intermediate brief/log/warn/error + cards)
 * @returns merged, timestamp-sorted, MAX_LOG_SIZE-capped LogEntry[]
 *
 * Falls back to messageLog alone when no transcript is available (e.g. serve
 * started before session init).
 */
export function readHistory(
  transcriptPath: string | null,
  userLogPath: string | null,
  messageLog: LogEntry[],
): LogEntry[] {
  if (transcriptPath) {
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf-8');
      const entries: LogEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: { role?: string; content?: string; timestamp?: number };
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // skip malformed lines
        }
        if (msg.content === undefined || msg.content === null || msg.content === '') continue;
        // Skip role:'user' from the triologue — these are injected system
        // notes ([REMINDER]/[HINT]/[WRAP_UP] etc.), NOT real user input.
        // Real user bubbles come from the user log (read below).
        if (msg.role === 'user') continue;
        const type = roleToType(msg.role);
        const label = roleToLabel(msg.role);
        const entry: LogEntry = { type, content: stripAnsi(String(msg.content)) };
        if (label) entry.label = label;
        // The triologue Message carries a timestamp (written by the onMessage
        // callback in agent-repl.ts). Use it for chronological merge with the
        // user log. Older transcripts (pre-timestamp) have no field; omit it
        // rather than emitting a bogus 0.
        if (typeof msg.timestamp === 'number') entry.timestamp = msg.timestamp;
        entries.push(entry);
      }

      // Read the user log (real user submissions) and merge by timestamp.
      const userEntries = readUserLog(userLogPath);

      // Merge triologue entries + user entries + in-memory messageLog by
      // timestamp. Entries without a timestamp (legacy transcript lines)
      // sort first via the `?? 0` fallback so they stay at their natural position.
      const combined = entries.concat(userEntries).concat(messageLog);
      combined.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

      // Cap at MAX_LOG_SIZE (keep the most recent entries)
      if (combined.length > MAX_LOG_SIZE) {
        return combined.slice(combined.length - MAX_LOG_SIZE);
      }
      return combined;
    } catch {
      // File missing or unreadable — fall through to messageLog
    }
  }
  return messageLog;
}