/**
 * triologue/transcript.ts - Append-only piece writer + read-time collation core
 *
 * The `{A, AB}` backlog fix: every triologue producer call that APPENDS a
 * message to the livelog emits exactly ONE flat JSONL line (a "piece");
 * a call that merely MUTATES an existing message (the user()/note() combine
 * branches) emits ZERO full-snapshot lines — the caller emits a `merge`
 * piece for the fragment instead. The transcript therefore never contains
 * the grown prefix of an earlier line.
 *
 * Reading is the inverse: `readTranscript()` parses the (legacy-tolerant)
 * record log and the two collation projections replay the appends into
 * the same message[] shape the livelog held — `collateMessages()` for the
 * restoration/summarizer view and `collateEntries()` for the serveHub
 * history view. Because the collator replays exactly the appends the
 * livelog performed (`new` => push, `merge` => append content to the last
 * collated message), the collated view is triologue-parity-equivalent to
 * the livelog by construction.
 *
 * Record shape (FLAT — message fields at top level, collation metadata
 * alongside; no {kind,turn_id,message} envelope, so session-introspect's
 * jq recipes and readHistory's field access keep working):
 *   { ...messageFields, kind: 'new'|'merge', turn_id: number,
 *     user_origin?: true, timestamp: number }
 * Legacy lines (full snapshots without `kind`) are treated as `new`
 * plain Messages on read — zero migration.
 *
 * CAVEAT (documented in the plan): removals (compact/clear/rollback/recap
 * truncation) are NOT journaled — the collated view is the durable FULL
 * session history, correct for a history/restore reader, not a substitute
 * for the live LLM context.
 */

import * as fs from 'fs';

/** Collation kind of a transcript piece. */
export type PieceKind = 'new' | 'merge';

/** One flat JSONL transcript record (a single emitted piece). */
export type TranscriptRecord = {
  /** Collation kind: replayed as push ('new') or fold-into-last ('merge') */
  kind: PieceKind;
  /** Turn identity inherited from the host message this piece belongs to */
  turn_id: number;
  /** True only for pieces carrying genuine user input (never notes/bridges) */
  user_origin?: true;
  /** Wall-clock ms at append time (preserved by collateEntries for UI ordering) */
  timestamp: number;
} & Record<string, unknown>;

/** Result of reading a transcript file. */
export interface ReadTranscriptResult {
  /** Successfully parsed records, in file order (malformed lines skipped) */
  records: TranscriptRecord[];
  /** Number of malformed/partial trailing lines skipped */
  skippedLines: number;
}

/**
 * Read a transcript file into flat records.
 *
 * Legacy tolerance (zero migration): a line without a `kind` field is a
 * plain Message from the pre-piece format — it is returned as a `new`
 * record with `turn_id: 0` and whatever `timestamp` the line carried
 * (0 when absent). Malformed / partial trailing lines (torn writes, human
 * edits) are skipped rather than throwing.
 *
 * Each returned record has exactly one message object per line: legacy
 * snapshot lines are NOT deduplicated into one message (the {A, AB}
 * duplicates already baked into old files are preserved on read — identical
 * to today's behavior; only sessions recorded with this writer are clean).
 */
export function readTranscript(filePath: string): ReadTranscriptResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { records: [], skippedLines: 0 };
  }

  const records: TranscriptRecord[] = [];
  let skippedLines = 0;

  if (raw.length === 0) {
    return { records, skippedLines };
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed / partial trailing line — skip, never throw
      skippedLines++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skippedLines++;
      continue;
    }
    const obj = parsed as { [key: string]: unknown };
    const kind = obj.kind;
    if (kind === 'new' || kind === 'merge') {
      records.push(obj as TranscriptRecord);
    } else if (kind === undefined) {
      // Legacy line: a plain Message written by the old full-snapshot writer.
      // Treated as a 'new' piece; envelope keys never existed, nothing to strip.
      records.push({
        ...obj,
        kind: 'new',
        turn_id: 0,
        timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : 0,
      } as TranscriptRecord);
    } else {
      // Unknown kind — a forward-format or corrupt line; skip rather than
      // guess how to collate it.
      skippedLines++;
    }
  }

  return { records, skippedLines };
}

/**
 * Collate transcript records into the message[] the livelog held.
 * Replay in order: 'new' => push; 'merge' => append the piece content to
 * the LAST collated message (as `\n` + content), verifying the turn_id
 * matches — a mismatch is recorded as an anomaly and the piece is still
 * folded into last (matching the livelog, which has no other fold target;
 * the anomaly surfaces the data corruption rather than silently dropping
 * the content).
 *
 * Envelope keys (kind/turn_id/user_origin) and the record timestamp are
 * stripped so nothing leaks into minifyMessages or the provider payload.
 */
/**
 * Optional anomaly observer — invoked once per detected replay anomaly
 * (merge without a user host, turn_id mismatch). Runtime consumers pass
 * nothing (collation stays silent); tests and diagnostics can observe.
 */
export type CollateAnomalyHandler = (anomaly: string) => void;

/**
 * Index of the last user-role item in the collated view, scanned from the
 * end, or -1. This matches the livelog's combine fold target (`store.last()`,
 * which is guaranteed user-role whenever a combine fires) AND generalizes to
 * the best-guess recovery for corrupt piece orderings: a merge whose user run
 * was interrupted by another append folds onto the nearest earlier user turn
 * instead of mangling the sequence.
 */
function lastIndexOfRole(
  getRole: (index: number) => string,
  length: number,
  role: string,
): number {
  for (let i = length - 1; i >= 0; i--) {
    if (getRole(i) === role) return i;
  }
  return -1;
}

export function collateMessages(
  records: TranscriptRecord[],
  onAnomaly?: CollateAnomalyHandler,
): Array<{ role: string; content: string; [key: string]: unknown }> {
  const messages: Array<{ role: string; content: string; [key: string]: unknown }> = [];
  // Turn identity of each collated message, kept BESIDE the message objects
  // (envelope keys are stripped from the output) so the turn_id integrity
  // check below reads real values instead of a never-present stripped key.
  const hostTurnIds: number[] = [];

  const emitAnomaly = (anomaly: string): void => {
    try {
      onAnomaly?.(anomaly);
    } catch {
      // An observer error must never break collation.
    }
  };

  for (const record of records) {
    // The spread copies every non-envelope key (role/content/tool_name/
    // tool_call_id/reasoning_content/hook_name/...) in insertion order.
    const { kind: _k, turn_id: _t, user_origin: _u, timestamp: _ts, ...message } = record;
    void _k; void _t; void _u; void _ts;
    if (message.role === undefined) continue; // defensive: never push shapeless records

    if (record.kind === 'merge') {
      const hostIndex = lastIndexOfRole((i) => String(messages[i].role), messages.length, 'user');
      if (hostIndex === -1) {
        // Defensive: no user host anywhere — the piece cannot be folded, so
        // keep its content (push as its own message) rather than drop it.
        emitAnomaly(`merge without a user host (turn_id=${record.turn_id}) — pushed as its own message`);
        messages.push(message as unknown as { role: string; content: string; [key: string]: unknown });
        hostTurnIds.push(Number(record.turn_id ?? 0));
      } else {
        const hostTurn = hostTurnIds[hostIndex];
        if (Number(record.turn_id) !== Number(hostTurn)) {
          emitAnomaly(`turn_id mismatch (host=${hostTurn}, piece=${record.turn_id}) — folded anyway`);
        }
        // Note: a 'merge' piece carries only role+content from the current
        // producers (the user()/note() combine fragments), so plain content
        // folding is complete. If future producers emit field-bearing merge
        // pieces, the fold policy belongs here.
        const host = messages[hostIndex];
        host.content = `${host.content}\n${message.content}`;
      }
    } else {
      messages.push(message as unknown as { role: string; content: string; [key: string]: unknown });
      hostTurnIds.push(Number(record.turn_id ?? 0));
    }
  }

  return messages;
}

/**
 * Collate transcript records preserving per-piece timestamps — the
 * serve-history projection (entry-level UI ordering), consumed by
 * serve-history.readHistory via LogEntry mapping. Same replay rules as
 * collateMessages() (fold onto the last user host), with one difference:
 *
 * A folded entry keeps the HOST's timestamp — the wall-clock moment the
 * turn's user message was appended — so serve-history chronological merge
 * (combined.sort by timestamp) places the completed user turn BEFORE the
 * assistant response that answered it, exactly where the livelog placed
 * the turn start. Using the piece timestamp instead (the merge's append
 * time, always later) would flicker the turn after its reply in the UI.
 * Untimestamped legacy pieces (timestamp 0) stay orderable alongside
 * timestamped ones by emission order (see pitfall 8547e85b: readHistory
 * must never sort untimestamped entries to the head — readHistory drops
 * timestamp<=0 entries instead).
 */
export function collateEntries(
  records: TranscriptRecord[],
  onAnomaly?: CollateAnomalyHandler,
): Array<{
  message: { role: string; content: string; [key: string]: unknown };
  timestamp: number;
}> {
  const entries: Array<{
    message: { role: string; content: string; [key: string]: unknown };
    timestamp: number;
  }> = [];
  // HOST timestamp + turn identity of each collated entry, kept beside the
  // entry objects: a fold copies these from the host instead of inheriting
  // the merge piece's own (later) timestamps.
  const hostTimestamps: number[] = [];
  const hostTurnIds: number[] = [];

  const emitAnomaly = (anomaly: string): void => {
    try {
      onAnomaly?.(anomaly);
    } catch {
      // An observer error must never break collation.
    }
  };

  for (const record of records) {
    const { kind: _k, turn_id: _t, user_origin: _u, ...message } = record;
    void _k; void _t; void _u;
    const timestamp = typeof record.timestamp === 'number' ? record.timestamp : 0;
    if (message.role === undefined) continue; // defensive

    if (record.kind === 'merge') {
      const hostIndex = lastIndexOfRole((i) => String(entries[i].message.role), entries.length, 'user');
      if (hostIndex === -1) {
        // Defensive: no user host anywhere — keep the content as its own
        // entry (its piece timestamp is the host timestamp of a new group).
        emitAnomaly(`merge without a user host (turn_id=${record.turn_id}) — pushed as its own entry`);
        entries.push({ message: message as unknown as { role: string; content: string; [key: string]: unknown }, timestamp });
        hostTimestamps.push(timestamp);
        hostTurnIds.push(Number(record.turn_id ?? 0));
      } else {
        const hostTurn = hostTurnIds[hostIndex];
        if (Number(record.turn_id) !== Number(hostTurn)) {
          emitAnomaly(`turn_id mismatch (host=${hostTurn}, piece=${record.turn_id}) — folded anyway`);
        }
        entries[hostIndex].message.content = `${entries[hostIndex].message.content}\n${message.content}`;
        // The entry's timestamp stays at the HOST's timestamp (the turn
        // start); the merge piece's own timestamp is deliberately NOT taken.
      }
    } else {
      entries.push({ message: message as unknown as { role: string; content: string; [key: string]: unknown }, timestamp });
      hostTimestamps.push(timestamp);
      hostTurnIds.push(Number(record.turn_id ?? 0));
    }
  }

  return entries;
}

/**
 * The message piece accepted by `JsonlTranscriptWriter.append`.
 * Deliberately `unknown`-index based with a structural role/content core and
 * an `as Record<string, unknown>`-shaped cast helper (`asAppendablePiece`)
 * rather than a nominal `Message` — `Message` has no index signature, so a
 * structural type keeps the write path generic (it also accepts the
 * envelope-stamped shallow copies the facades emit) while the read path
 * stays shapeless by design.
 */
export type MessageLike = {
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

/** The write-path shape: a message piece plus optional pre-stamped metadata. */
export type AppendablePiece = MessageLike & Partial<TranscriptRecord>;

/**
 * Widen an arbitrary role/content-bearing piece (e.g. the facades' Message
 * shallow copies, which carry no index signature) to the appendable piece
 * shape. A safe `as unknown as` is acceptable HERE and ONLY HERE — the
 * collation core is the single serialization boundary and it re-validates
 * shape on read (malformed lines are skipped, records without role are
 * never pushed).
 */
export function asAppendablePiece(piece: unknown): AppendablePiece {
  return piece as AppendablePiece;
}

/**
 * Append-only JSONL transcript writer.
 *
 * ONE `appendFileSync` per appended message; never seek/truncate/stat/read
 * on the write path; never throws (errors go to the onError callback so a
 * full disk degrades to a transcript gap, not a crashed turn).
 */
export class JsonlTranscriptWriter {
  private readonly filePath: string;
  private readonly onError: (err: unknown, filePath: string) => void;

  constructor(filePath: string, onError?: (err: unknown, filePath: string) => void) {
    this.filePath = filePath;
    this.onError = onError ?? (() => {});
  }

  /**
   * Append exactly one flat record line. `message` is the piece (already
   * stamped with kind/turn_id/user_origin by the facade's dispatcher); the
   * timestamp is added here at write time (single clock, monotonic per line).
   */
  append(message: AppendablePiece): void {
    const { kind, turn_id, user_origin, ...messageFields } = message;
    void user_origin;
    const record: TranscriptRecord = {
      ...messageFields,
      kind: (kind ?? 'new') as PieceKind,
      turn_id: turn_id ?? 0,
      ...(user_origin !== undefined ? { user_origin: true } : {}),
      timestamp: Date.now(),
    };
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (err) {
      this.onError(err, this.filePath);
    }
  }
}