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

/**
 * djb2 string hash (Daniel J. Bernstein). Returns an unsigned hex string
 * (no leading 0x). Chosen for cheapness and good distribution over short
 * input strings — the version fingerprint is rebuilt on every /history GET,
 * so it must stay far cheaper than serializing the body it guards.
 */
function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; // h*33 + c, unsigned 32-bit
  }
  return h.toString(16);
}

/**
 * Compute a content-derived weak ETag for the /history payload WITHOUT
 * serializing the body.
 *
 * Instead of hashing the rendered JSON, this fingerprints the INPUTS that
 * determine the body:
 *   - transcript file: statSync mtimeMs + size (covers appended turns)
 *   - user-log file:   statSync mtimeMs + size (covers appended user submits)
 *   - messageLog:      length + last entry's timestamp (in-memory tail)
 *   - steeringBuffer:  its length (the transient steering queue — flips as
 *                       notes are pushed/drained; NOT a durable file, so a
 *                       body-content hash that folds these fields in would
 *                       diverge from a file-only fingerprint. Without it a
 *                       steering push would be masked by a 304.)
 *   - isRunning:       the agent running flag (transient — a running/idle
 *                       flip changes the payload's `isRunning` field but no
 *                       durable file, so it MUST be folded in or a 304 hides
 *                       the state change and shows stale UI.)
 *
 * Returns a weak ETag of the form `W/"h<hex>"`. The `W/` prefix marks it as
 * weak (semantically equivalent bodies may share a tag), which is correct
 * here because two bodies whose only difference is entry insertion order
 * (same multiset of timestamped entries) are visually equivalent.
 *
 * The only impurity is `fs.statSync` (mtimeMs/size). Everything else is a
 * pure function of the arguments, so the unit tests stub the file stats via
 * a temp-dir fixture and otherwise exercise the pure core.
 */
export function computeHistoryVersion(
  transcriptPath: string | null,
  userLogPath: string | null,
  messageLog: LogEntry[],
  steeringLength: number,
  isRunning: boolean,
): string {
  const parts: string[] = [];
  // Durable file fingerprints — mtimeMs + size. A missing file contributes
  // a stable "null" token (vs. an ever-changing zero) so an absent source
  // does not needlessly invalidate the ETag on every call.
  for (const p of [transcriptPath, userLogPath]) {
    if (!p) { parts.push('null'); continue; }
    try {
      const st = fs.statSync(p);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push('null'); // file missing/unreadable → stable token
    }
  }
  // In-memory messageLog tail: length + last timestamp (order-independent
  // in the middle, but the tail timestamp catches appends). When the log is
  // empty, emit a stable "0" so an empty log never varies.
  const lastTs = messageLog.length > 0
    ? (messageLog[messageLog.length - 1].timestamp ?? 0)
    : 0;
  parts.push(`log:${messageLog.length}:${lastTs}`);
  // Transient fields that live in the body but NOT in the durable files.
  parts.push(`steer:${steeringLength}`);
  parts.push(`running:${isRunning ? 1 : 0}`);
  return `W/"h${djb2(parts.join('|'))}"`;
}

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

      // Merge triologue entries + user entries + in-memory messageLog.
      // Filter out entries WITHOUT a timestamp — legacy pre-timestamp
      // transcript lines have no reliable chronological position, so
      // sorting them to 0 (front) or MAX_SAFE_INTEGER (end) would misorder
      // them relative to timestamped entries. Excluding them keeps the
      // reconstructed history chronologically accurate.
      const combined = entries
        .concat(userEntries)
        .concat(messageLog)
        .filter((e) => typeof e.timestamp === 'number');
      combined.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

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