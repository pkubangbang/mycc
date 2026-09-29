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
 * history view.
 *
 * THE REPLAY INVARIANT IS PURELY POSITIONAL (no secondary identity system):
 *
 *   kind:'new'    → push the piece as its own message
 *   kind:'merge'  → fold the piece content into the MOST RECENTLY COLLATED
 *                   user-role message (tracked by a single `lastUserIndex`
 *                   cursor — O(n) replay, no backward scans)
 *   kind:'user' | 'steer'
 *                 → the USER-INPUT JOURNAL: one record per genuine user
 *                   submission (a typed query fragment folded into a
 *                   preceding user host, or a typed webui steering note).
 *                   Both are stamped `user_origin: true`. They are NOT
 *                   livelog mutations on their own terms:
 *                     'user'  — the livelog host really did grow (the
 *                               combine branch of user()), so the
 *                               restoration projection FOLDS it onto the
 *                               host to stay parity-equivalent.
 *                     'steer' — the text reached the LLM as the [REMINDER]
 *                               steering note the livelog recorded, so the
 *                               restoration projection SKIPS it (folding
 *                               would duplicate the note text).
 *                   The serve projection keeps both as their OWN entries:
 *                   that journal is the single source of truth for the
 *                   right-side user bubbles (see serve-history.ts), which is
 *                   why a refresh no longer depends on the serve-only
 *                   user.jsonl side file.
 *   kind:'clear' | 'compact' | 'recap' | 'rollback'
 *                 → a journaled truncation boundary, carrying NO message
 *                   fields (no role). The clear semantics are a property of
 *                   the PROJECTION, not of the shared core:
 *                   `collateMessages()` (the restoration view) RESETS on
 *                   `kind:'clear'` — records after a clear start a fresh
 *                   collated view, so restored context honors the /clear
 *                   (cleared material does NOT resurrect); the serve
 *                   projection `collateEntries()` is archival and KEEPS the
 *                   cleared material (the durable user-input journal and the
 *                   in-memory serve log are not cut by /clear either — a
 *                   one-sided reset would orphan pre-clear user bubbles in
 *                   the UI). All
 *                   boundary kinds (including clear) are journaled as
 *                   observable markers in the record stream; compact/
 *                   recap/rollback never cut EITHER projection — the
 *                   collated view (durable FULL history, a superset of the
 *                   live LLM context) is kept for both readers.
 *
 * The boundary kinds are CONFLATED into `kind` (no 'control' pseudo-kind,
 * no separate `event` field) — the flat record stream reads directly:
 *
 * Record shape (FLAT — message fields at top level, collation metadata
 * alongside; no {kind,message} envelope, so session-introspect's
 * jq recipes and readHistory's field access keep working):
 *   { ...messageFields, kind: 'new'|'merge', user_origin?: true,
 *     timestamp: number }
 *   { ...messageFields, kind: 'user'|'steer', user_origin: true,
 *     timestamp: number }
 *   { kind: 'clear'|'compact'|'recap'|'rollback', timestamp: number }
 *
 * Legacy lines (full snapshots without `kind`) are treated as `new`
 * plain Messages on read — zero migration.
 *
 * The only anomaly is STRUCTURAL: a merge piece (or a folded 'user' journal
 * record) with no user message in the collated view — its content is kept as
 * its own message instead of being dropped. There is no turn-identity layer
 * pretending to be authoritative — stream position alone determines
 * ownership of a fold.
 */

import * as fs from 'fs';

/**
 * Collation kind of a transcript piece. Message pieces carry
 * 'new'/'merge'/'user'/'steer'; the boundary kinds
 * ('clear'|'compact'|'recap'|'rollback') are journaled
 * truncation events CONFLATED into the kind field (no 'control' pseudo-kind
 * — kind IS the event for boundary records).
 */
export type PieceKind = 'new' | 'merge' | UserJournalKind | ControlEvent;

/**
 * The user-input journal kinds: message-bearing records that carry ONE
 * genuine user submission each (never an injected note), stamped
 * `user_origin: true`.
 *
 *   'user'  — a typed user fragment folded into the preceding user host by
 *             the user() combine branch (the livelog host really did grow
 *             by `\n<fragment>`, so the restoration projection folds it).
 *   'steer' — a typed webui steering note (submitted mid-run). The livelog
 *             recorded the note as the [REMINDER] steering note, so the
 *             restoration projection SKIPS it (folding would duplicate).
 *
 * The serve projection keeps both as their own entries — this journal is the
 * single source of truth for right-side user bubbles on /history.
 */
export type UserJournalKind = 'user' | 'steer';

/** The subset of PieceKind values that are user-input journal records. */
export const USER_JOURNAL_KINDS: readonly UserJournalKind[] = ['user', 'steer'];

/** Narrow a raw PieceKind: is the record a user-input journal entry? */
export function isUserJournalKind(kind: unknown): kind is UserJournalKind {
  return typeof kind === 'string' && USER_JOURNAL_KINDS.includes(kind as UserJournalKind);
}

/** Journaled live-log truncation/boundary events (carried directly on `kind`). */
export type ControlEvent = 'clear' | 'compact' | 'recap' | 'rollback';

/** The subset of PieceKind values that are journaled boundary events. */
export const CONTROL_KINDS: readonly ControlEvent[] = ['clear', 'compact', 'recap', 'rollback'];

/** Narrow a raw PieceKind: is the record a journaled boundary marker? */
export function isControlKind(kind: unknown): kind is ControlEvent {
  return typeof kind === 'string' && CONTROL_KINDS.includes(kind as ControlEvent);
}

/** One flat JSONL transcript record (a single emitted piece or control event). */
export type TranscriptRecord = {
  /** Collation kind: replayed as push ('new'), fold-into-last-user ('merge'), a user-input journal entry ('user'|'steer'), or a journaled boundary ('clear'|'compact'|'recap'|'rollback') */
  kind: PieceKind;
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
 * record with whatever `timestamp` the line carried (0 when absent).
 * Malformed / partial trailing lines (torn writes, human edits) are skipped
 * rather than throwing.
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
    if (kind === 'new' || kind === 'merge' || isControlKind(kind)) {
      records.push(obj as TranscriptRecord);
    } else if (isUserJournalKind(kind)) {
      // The user-input journal: a genuine submission (folded query fragment
      // or typed steering note). Shape-validated rather than trusted — a
      // record claiming user origin MUST be a user message; anything else is
      // treated as corrupt/forward-format and skipped (never guessed), so a
      // malformed line can never smuggle an injected note into the user
      // bubbles rendered by serve-history.
      if (obj.role !== 'user' || obj.user_origin !== true) {
        skippedLines++;
        continue;
      }
      records.push(obj as TranscriptRecord);
    } else if (kind === undefined) {
      // Legacy line: a plain Message written by the old full-snapshot writer.
      // Treated as a 'new' piece; envelope keys never existed, nothing to strip.
      records.push({
        ...obj,
        kind: 'new',
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
 * Optional anomaly observer — invoked once per detected structural replay
 * anomaly (a merge piece with no user message in the collated view).
 * Runtime consumers pass nothing (collation stays silent); tests and
 * diagnostics can observe.
 */
export type CollateAnomalyHandler = (anomaly: string) => void;

export function collateMessages(
  records: TranscriptRecord[],
  onAnomaly?: CollateAnomalyHandler,
): Array<{ role: string; content: string; [key: string]: unknown }> {
  const messages: Array<{ role: string; content: string; [key: string]: unknown }> = [];
  // Positional fold cursor: index of the most recently COLLATED user-role
  // message, or -1. A merge piece folds onto messages[lastUserIndex] —
  // stream position alone determines merge ownership (the replay invariant).
  // Maintained incrementally so replay stays O(n) even in merge-heavy
  // transcripts.
  let lastUserIndex = -1;

  const emitAnomaly = (anomaly: string): void => {
    try {
      onAnomaly?.(anomaly);
    } catch {
      // An observer error must never break collation.
    }
  };

  for (const record of records) {
    if (isControlKind(record.kind)) {
      if (record.kind === 'clear') {
        // Journaled /clear: the live context was emptied here — the collated
        // view resets so restored context does not resurrect cleared material.
        messages.length = 0;
        lastUserIndex = -1;
      }
      // compact/recap/rollback (and any future boundary marker) do NOT cut
      // the collated view: the durable full history stays intact for the
      // restore/history readers; the mark remains in the record stream as
      // an observable boundary.
      continue; // boundary records never become messages
    }

    // A typed steering note is a DISPLAY journal entry, not a livelog
    // mutation: its text reached the LLM as the [REMINDER] steering note the
    // livelog already recorded (and which this projection replays). Folding
    // it here would duplicate the note text in restored context.
    if (record.kind === 'steer') continue;

    // The spread copies every non-envelope key (role/content/tool_name/
    // tool_call_id/reasoning_content/hook_name/...) in insertion order.
    const { kind: _k, user_origin: _u, timestamp: _ts, ...message } = record;
    void _k; void _u; void _ts;
    if (message.role === undefined) continue; // defensive: never push shapeless records

    if ((record.kind === 'merge' || record.kind === 'user') && lastUserIndex !== -1) {
      // Note: a 'merge'/'user' piece carries only role+content from the
      // current producers (the user()/note() combine fragments), so plain
      // content folding is complete. If future producers emit field-bearing
      // merge pieces, the fold policy belongs here.
      //
      // 'user' folds for livelog parity: the combine branch grew the host by
      // exactly `\n<fragment>` in memory, so replaying the journal restores
      // the same message[] the livelog held.
      const host = messages[lastUserIndex];
      host.content = `${host.content}\n${message.content}`;
    } else if (record.kind === 'merge' || record.kind === 'user') {
      // Defensive (structural anomaly): no user host in the collated view —
      // the piece cannot be folded, so keep its content (push as its own
      // message) rather than drop it.
      emitAnomaly(`${record.kind} without a user host — pushed as its own message`);
      messages.push(message as unknown as { role: string; content: string; [key: string]: unknown });
      if (message.role === 'user') lastUserIndex = messages.length - 1;
    } else {
      messages.push(message as unknown as { role: string; content: string; [key: string]: unknown });
      if (message.role === 'user') lastUserIndex = messages.length - 1;
    }
  }

  return messages;
}

/**
 * Collate transcript records preserving per-piece timestamps — the
 * serve-history projection (entry-level UI ordering), consumed by
 * serve-history.readHistory via LogEntry mapping.
 *
 * This projection is the USER-BUBBLE SOURCE for the WebUI, so it is a CLEAN
 * SCAN rather than a replay of the livelog:
 *
 *   - A user-input journal record ('user' | 'steer') becomes its OWN entry
 *     at its own timestamp — one right-side bubble per genuine submission,
 *     whether the query was appended fresh or folded into a preceding user
 *     host by the combine branch.
 *   - A marker-bearing 'new' user record (user_origin:true — the plain
 *     query and the post-tool fast path) also becomes its own entry.
 *   - A 'merge' piece is SKIPPED: it is a system-note fragment
 *     ([REMINDER]/[HINT]/[WRAP_UP]...) that must never render as a user
 *     bubble. Likewise a 'new' user record WITHOUT user_origin (wrap-up
 *     markers, restoration summaries, standalone/hook notes, TP bridges) is
 *     skipped — that anti-pollution rule is why readHistory historically
 *     dropped all role:'user' records, now applied precisely at record level.
 *   - assistant/tool/system records are pushed as before; boundary kinds are
 *     observable markers that never cut this archival view.
 *
 * Every genuine user submission therefore carries its own timestamp (written
 * by JsonlTranscriptWriter at append time), so readHistory no longer needs a
 * timestamp filter to keep untimestamped legacy lines out of the ordering —
 * it normalises them in emission order instead (pitfall 8547e85b).
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

  const emitAnomaly = (anomaly: string): void => {
    try {
      onAnomaly?.(anomaly);
    } catch {
      // An observer error must never break collation.
    }
  };

  for (const record of records) {
    if (isControlKind(record.kind)) {
      // Archival semantics (review F2, resolution (b)): the serve-history
      // view keeps the durable FULL history. A clear is journaled as an
      // observable boundary marker here but does NOT cut this projection —
      // only the restoration projection (collateMessages) honors the /clear
      // reset. Cutting this view while the durable journal stays intact
      // would orphan pre-clear user bubbles (an inconsistent half-cut for an
      // archival consumer).
      continue;
    }

    // A note fragment folded into a user host — never a user bubble.
    if (record.kind === 'merge') continue;

    const timestamp = typeof record.timestamp === 'number' ? record.timestamp : 0;

    // The user-input journal: one entry per genuine submission.
    if (isUserJournalKind(record.kind)) {
      const { kind: _k, user_origin: _u, timestamp: _ts, ...message } = record;
      void _k; void _u; void _ts;
      if (message.role === undefined) {
        emitAnomaly(`${record.kind} journal record without a role — skipped`);
        continue;
      }
      entries.push({ message: message as unknown as { role: string; content: string; [key: string]: unknown }, timestamp });
      continue;
    }

    const { kind: _k, user_origin, timestamp: _ts, ...message } = record;
    void _k; void _ts;
    if (message.role === undefined) continue; // defensive
    if (message.role === 'user' && user_origin !== true) continue; // injected note, not input
    entries.push({ message: message as unknown as { role: string; content: string; [key: string]: unknown }, timestamp });
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
 * A journaled boundary mark: a boundary record (no message fields) written
 * when the live log is truncated or swapped — clear / compact / recap /
 * rollback. CONFLATED into `kind`: written to the transcript as
 * `{ kind, timestamp }` (no 'control' pseudo-kind, no `event` field).
 */
export type ControlPiece = {
  kind: ControlEvent;
};

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
 * ONE `appendFileSync` per appended message or journaled control event;
 * never seek/truncate/stat/read on the write path; never throws (errors go
 * to the onError callback so a full disk degrades to a transcript gap, not
 * a crashed turn) — the callback invocation itself is guarded so an
 * observer that throws cannot break the writer either.
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
   * stamped with kind/user_origin by the facade's dispatcher — a
   * 'new'/'merge' message piece, a 'user'/'steer' user-input journal record,
   * or a bare boundary piece { kind:'clear'|'compact'|'recap'|'rollback' });
   * the timestamp is added here at write time (single clock, monotonic
   * per line).
   */
  append(message: AppendablePiece | ControlPiece): void {
    const piece = message as Record<string, unknown>;
    const { kind, user_origin, ...messageFields } = piece;
    void user_origin;
    const record: TranscriptRecord = {
      ...messageFields,
      kind: (kind ?? 'new') as PieceKind,
      ...(user_origin !== undefined ? { user_origin: true } : {}),
      timestamp: Date.now(),
    };
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (err) {
      try {
        this.onError(err, this.filePath);
      } catch {
        // Observers must never break the writer (the never-throws contract).
      }
    }
  }

  /**
   * Journal a boundary mark (a live-log truncation/boundary: clear / compact
   * / recap / rollback). One flat `{ kind, timestamp }` line — no message
   * fields, the event name IS the kind (conflated). Same error policy as
   * append() (never throws).
   */
  control(event: ControlEvent): void {
    this.append({ kind: event } as ControlPiece);
  }
}