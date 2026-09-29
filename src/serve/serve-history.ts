/**
 * serve-history.ts - chat-history reconstruction for the /history endpoint
 *
 * Extracted from ServeHub as pure functions that take their data sources
 * (the transcript path, the in-memory messageLog) as parameters, so the
 * merging logic can be reasoned about and tested without importing the heavy
 * serve-hub.ts module graph (Express + Vite + agent-io).
 *
 * History is reconstructed from TWO sources, merged by timestamp:
 *
 * 1. The triologue JSONL transcript (transcriptPath) — assistant/tool/system
 *    turns AND the genuine user bubbles. The transcript is the SINGLE SOURCE
 *    OF TRUTH for what the user typed: every real submission is journaled
 *    there as a user-input record (kind 'user'|'steer', or a marker-bearing
 *    'new' piece), which collateEntries() projects one-to-one onto right-side
 *    bubbles. Injected system notes ([REMINDER]/[HINT]/[WRAP_UP] etc.) are
 *    'merge' fragments or unmarked 'new' user pieces and are SKIPPED, so they
 *    never render as user input. Because the transcript is written on every
 *    turn (terminal mode included), a query survives a page refresh, a serve
 *    restart, and a page close — no serve-only side file is involved.
 *
 * 2. The in-memory messageLog (intermediate brief/log/warn/error + cards) —
 *    serve-lifetime only, appended after and sorted into the same sequence.
 */
import * as fs from 'fs';
import { stripAnsi } from './serve-utils.js';
import type { LogEntry } from './serve-types.js';
import { readTranscript, collateEntries } from '../loop/triologue/transcript.js';

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
 *   - transcript file: statSync mtimeMs + size (covers appended turns AND
 *                       appended user-input journal records — the transcript
 *                       is the single durable source of history)
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
  messageLog: LogEntry[],
  steeringLength: number,
  isRunning: boolean,
): string {
  const parts: string[] = [];
  // Durable file fingerprint — mtimeMs + size. A missing file contributes
  // a stable "null" token (vs. an ever-changing zero) so an absent source
  // does not needlessly invalidate the ETag on every call.
  if (!transcriptPath) {
    parts.push('null');
  } else {
    try {
      const st = fs.statSync(transcriptPath);
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

/**
 * Parse a single entity-tag token (as it appears in an If-None-Match list or
 * as a response ETag) into its opaque-tag string for WEAK comparison,
 * per RFC 7232 §2.3. Weak comparison (§2.3.2) ignores the weak/strong
 * distinction: it strips the leading `W/` and compares only the
 * quoted opaque-tag. Returns null for a malformed token (not a valid
 * entity-tag, e.g. the wildcard `*` is handled by the caller, not here).
 *
 *   W/"abc"  → "abc"
 *   "abc"    → "abc"
 *   "abc     → null   (unterminated quote)
 *   abc      → null   (unquoted)
 */
function parseEtagToken(token: string): string | null {
  let t = token.trim();
  if (t.startsWith('W/')) t = t.slice(2);
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') return null;
  return t.slice(1, -1); // the opaque tag inside the quotes
}

/**
 * RFC 7232 §3.2 If-None-Match conditional check (weak comparison), as a PURE
 * function so the matching logic is unit-testable without spinning up
 * Express.
 *
 * `headerValue` is the raw If-None-Match header (a comma-separated list of
 * entity-tags, or the wildcard `*`). `currentEtag` is the ETag the server
 * would send on this response (a single entity-tag, possibly weak).
 *
 * Returns true when the precondition is met — i.e. the server should respond
 * 304 Not Modified:
 *   - `*` matches ANY current representation (RFC 7232 §3.2: "the asterisk
 *     form matches any value").
 *   - otherwise, true if ANY listed entity-tag WEAKLY-matches the current
 *     ETag (weak comparison: strip W/ from both sides, compare the opaque
 *     tags). RFC 7232 §2.3.2: weak comparison ignores the strong/weak
 *     distinction, which is exactly what If-None-Match requires.
 *
 * This replaces the prior manual `inm === etag` equality, which only handled
 * the single-tag, exact-string case and silently failed on a header with
 * multiple tags (e.g. `"a", W/"b"`) or a strong/weak-equivalent pair.
 */
export function etagMatchesIfNoneMatch(headerValue: string | undefined | null, currentEtag: string): boolean {
  if (!headerValue) return false;
  const raw = headerValue.trim();
  if (raw === '') return false;
  if (raw === '*') return true; // wildcard matches any current representation
  const current = parseEtagToken(currentEtag);
  if (current === null) return false; // malformed current ETag — never 304
  // Split on commas. Entity-tags are quoted strings (the opaque tag may NOT
  // contain a bare comma — RFC 7232 §2.3: the opaque-tag is a quoted-string,
  // and a comma inside a quoted-string is allowed but never appears in our
  // h<hex> tags, so a naive comma split is safe for our emitted tags; for
  // robustness we parse each candidate with parseEtagToken which rejects
  // malformed tokens rather than mis-splitting).
  for (const candidate of raw.split(',')) {
    const tag = parseEtagToken(candidate);
    if (tag !== null && tag === current) return true;
  }
  return false;
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
 * Reconstruct the full chat history for the /history endpoint.
 *
 * @param transcriptPath - durable triologue JSONL path (assistant/tool/system
 *                         turns AND the genuine user-input journal)
 * @param messageLog     - in-memory log (intermediate brief/log/warn/error + cards)
 * @returns merged, timestamp-sorted, MAX_LOG_SIZE-capped LogEntry[]
 *
 * Falls back to messageLog alone when no transcript is available (e.g. serve
 * started before session init).
 */
export function readHistory(
  transcriptPath: string | null,
  messageLog: LogEntry[],
): LogEntry[] {
  if (transcriptPath) {
    try {
      // Read the transcript through the shared collation core (the {A, AB}
      // fix): the file is an append-only PIECE log, replayed by the serve
      // projection into one entry per collated message. collateEntries() now
      // yields the RIGHT-SIDE USER BUBBLES too — a genuine submission is
      // journaled as a 'user'|'steer' record (or a marker-bearing 'new' user
      // piece), which the projection keeps one-to-one, while injected notes
      // ('merge' fragments, unmarked user pieces) are dropped. This is why
      // history no longer depends on the serve-only user.jsonl side file:
      // the transcript is written on every turn, terminal mode included.
      // Legacy tolerance: pre-piece full-snapshot lines have no `kind`, so
      // readTranscript treats each as a 'new' plain Message — their existing
      // {A, AB} duplicates in old files are preserved on read (zero
      // migration), identical to the previous raw-line parser's output.
      const { records } = readTranscript(transcriptPath);
      const entries: LogEntry[] = [];
      for (const entry of collateEntries(records)) {
        const msg = entry.message;
        if (msg.content === undefined || msg.content === null || msg.content === '') continue;
        const role = msg.role as string | undefined;
        const type = roleToType(role);
        const label = roleToLabel(role);
        const logEntry: LogEntry = { type, content: stripAnsi(String(msg.content)) };
        if (label) logEntry.label = label;
        // collateEntries preserves the piece timestamp (written by
        // JsonlTranscriptWriter at append time) — every genuine user
        // submission therefore carries a real timestamp.
        logEntry.timestamp = entry.timestamp;
        entries.push(logEntry);
      }

      // Timestamp normalisation, in EMISSION ORDER: the sort below is
      // chronological, so an entry with no usable timestamp (a legacy
      // pre-piece line — timestamp 0) must not fall back to 0 and jump to the
      // HEAD of the log (pitfall 8547e85b) *after* a timestamped record. We
      // therefore walk the entries forward and let each untimestamped entry
      // inherit the last positive timestamp seen SO FAR. A LEADING run of
      // untimestamped entries (no positive timestamp precedes them) stays at
      // 0 — there is no earlier record to inherit from, and back-filling them
      // from a LATER record would wrongly move a legacy prefix into the middle
      // of newer history once messageLog entries are merged (P1). A file whose
      // records are ALL untimestamped keeps them in file order (all equal ⇒ a
      // stable sort is a no-op).
      let knownTimestamp: number | undefined;
      for (const e of entries) {
        if (typeof e.timestamp === 'number' && e.timestamp > 0) {
          knownTimestamp = e.timestamp;
        } else if (knownTimestamp !== undefined) {
          e.timestamp = knownTimestamp;
        }
        // else: a leading untimestamped entry — leave its timestamp at 0 so
        // it sorts to the head, preserving file order before the first
        // timestamped record.
      }

      // Merge transcript entries + the in-memory messageLog, by timestamp.
      // Entries keep a numeric timestamp throughout: journal/legacy records
      // carry 0 (or the writer's clock), and the normalisation above assigns a
      // positive value where one is available, so the filter is defensive only.
      const combined = entries
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