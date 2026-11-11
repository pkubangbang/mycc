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
 *   kind:'clear' | 'compact' | 'rollback'
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
 *                   rollback never cuts EITHER projection — the
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
 *   { kind: 'clear'|'compact'|'rollback', timestamp: number }
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
 * ('clear'|'compact'|'rollback') are journaled
 * truncation events CONFLATED into the kind field (no 'control' pseudo-kind
 * — kind IS the event for boundary records).
 */
export type PieceKind = 'new' | 'merge' | UserJournalKind | ControlEvent | 'note';

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
export type ControlEvent = 'clear' | 'compact' | 'rollback' | 'segment-archive';

/** The subset of PieceKind values that are journaled boundary events. */
export const CONTROL_KINDS: readonly ControlEvent[] = ['clear', 'compact', 'rollback', 'segment-archive'];

/** Narrow a raw PieceKind: is the record a journaled boundary marker? */
export function isControlKind(kind: unknown): kind is ControlEvent {
  return typeof kind === 'string' && CONTROL_KINDS.includes(kind as ControlEvent);
}

/**
 * A DISPLAY NOTE: a line the terminal prints that is not an LLM message.
 *
 * `agentIO.brief()` prints `[HH:MM:SS] [tool] text` and mirrors the same text
 * to the WebUI. It has no place in the model's conversation, but it IS part of
 * what the user saw — so it is journaled as a role-less record in this same
 * stream and rendered by BOTH surfaces from that one record.
 *
 * Deliberately WITHOUT `role` and WITHOUT `content`: `collateMessages()`
 * (restoration / LLM context) skips role-less records, so a note can never
 * leak into the model's log; and the field name `note.text` (never `content`)
 * means serve-history's content guard and collateEntries' role guard cannot
 * disagree about it.
 */
export interface DisplayNote {
  level: 'info' | 'warn' | 'error';
  /** Tool/module tag rendered as the `[tool]` header, e.g. 'tool', 'brief'. */
  tool: string;
  /** The clean message body (no ANSI, no internal markup) — as mirrored. */
  text: string;
  /** `[HH:MM:SS]` header time, rendered identically by both sinks. */
  at: string;
  /** Optional outlined detail line (e.g. a tool's intent). */
  detail?: string;
  /** Machine-originated (hook engine / debug): OPERATIONAL ONLY — both
   *  renderers hide it; the terminal keeps printing it. */
  synthetic?: boolean;
  /** Structured crossroad payload, when the note carries one. */
  crossroad?: Record<string, unknown>;
  /**
   * `'message'` ⇒ this note is a TERMINAL ECHO of prose that is ALSO journaled
   * as its own message record (kind 'new', role assistant). It exists so the
   * terminal prints the mid-loop reply at the moment it is produced; it must
   * NOT draw a second chat row.
   *
   * WHY A FLAG AND NOT A CONTENT COMPARISON: the two records are written by
   * different code paths moments apart, and their text is normalised on the way
   * in (DSML stripping, ANSI stripping), so "same content" is a heuristic that
   * drifts. The producer KNOWS it is echoing a message it just registered, so it
   * says so, and the display projection drops exactly those notes.
   *
   * WHY THE NOTE IS STILL WRITTEN AT ALL: the transcript is also the terminal's
   * printed record. Dropping the note would silently delete a line the user saw
   * from any replay of the stream; only the CHAT projection hides it.
   */
  echoOf?: 'message';
  /**
   * Interactive card payload, when the note IS a card.
   *
   * Cards are journaled as notes so a pending widget survives a reload: the
   * messageLog copy is serve-lifetime only and /history no longer reads it, so
   * without a durable record a refresh left the agent blocked on a question the
   * browser could no longer show. Typed loosely (it is the serve layer's wire
   * shape) so this module keeps its distance from serve types.
   */
  /**
   * The card, journaled field-by-field at its SOURCE of truth: `brief()` builds
   * exactly these members, so a wrong shape fails at the writer instead of at
   * the projection. Declared here (not as `Record<string, unknown>`) because a
   * loose bag pushes the variance problem onto every reader — `projectDisplayRecord`
   * could not rebuild a typed row from it without re-spelling the contract.
   */
  card?: {
    type: 'card';
    cardId: string;
    query: string;
    kind: 'input' | 'confirm' | 'choice' | 'notice';
    options?: { label: string; value: string; isDefault?: boolean }[];
    initialContent?: string;
    placeholder?: string;
  };
}

/** One flat JSONL transcript record (a single emitted piece or control event). */
export type TranscriptRecord = {
  /** Collation kind: replayed as push ('new'), fold-into-last-user ('merge'), a user-input journal entry ('user'|'steer'), a journaled boundary ('clear'|'compact'|'rollback'), or a display note ('note') */
  kind: PieceKind;
  /** True only for pieces carrying genuine user input (never notes/bridges) */
  user_origin?: true;
  /** Wall-clock ms at append time (preserved by collateEntries for UI ordering) */
  timestamp: number;
  /**
   * Monotonic per-file sequence stamped by the writer.
   *
   * The ONE identity live WS frames and /history rows share: the client keeps
   * a cursor of the highest `seq` it has rendered and asks for records after
   * it, which closes the window between the HTTP snapshot and the socket
   * opening — without replaying history over the socket. Absent on records
   * written before this field existed (readers fall back to file order).
   */
  seq?: number;
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
    } else if (kind === 'note') {
      // DISPLAY NOTE: journaled so /history can replay what the terminal
      // printed, but role-less by construction — every message projection
      // (collateMessages, collateEntries) drops it, so the model never sees
      // it. Shape-validated: a note without its payload is corrupt.
      if (!obj.note || typeof obj.note !== 'object' || Array.isArray(obj.note)) {
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
        timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : 0
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
  onAnomaly?: CollateAnomalyHandler
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
      // compact/rollback (and any future boundary marker) do NOT cut
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
    void _k;
    void _u;
    void _ts;
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
      host.content = `${contentText(host.content)}\n${contentText(message.content)}`;
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
  onAnomaly?: CollateAnomalyHandler
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
      void _k;
      void _u;
      void _ts;
      if (message.role === undefined) {
        emitAnomaly(`${record.kind} journal record without a role — skipped`);
        continue;
      }
      entries.push({
        message: message as unknown as { role: string; content: string; [key: string]: unknown },
        timestamp
      });
      continue;
    }

    const { kind: _k, user_origin, timestamp: _ts, ...message } = record;
    void _k;
    void _ts;
    if (message.role === undefined) continue; // defensive
    if (message.role === 'user' && user_origin !== true) continue; // injected note, not input
    entries.push({
      message: message as unknown as { role: string; content: string; [key: string]: unknown },
      timestamp
    });
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

/**
 * Render a message's `content` for a string fold.
 *
 * `content` is `unknown` on this boundary (read path stays shapeless by
 * design), so interpolating it directly could produce `[object Object]`.
 * Strings pass through unchanged — the fold's original behaviour — and any
 * other shape is JSON-encoded so the collated transcript stays inspectable.
 */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** The write-path shape: a message piece plus optional pre-stamped metadata. */
export type AppendablePiece = MessageLike & Partial<TranscriptRecord>;

/**
 * A journaled boundary mark: a boundary record (no message fields) written
 * when the live log is truncated or swapped — clear / compact /
 * rollback. CONFLATED into `kind`: written to the transcript as
 * `{ kind, timestamp }` (no 'control' pseudo-kind, no `event` field).
 */
export type ControlPiece = {
  kind: ControlEvent;
};

/**
 * A DISPLAY NOTE piece: `{ kind:'note', note }`. Role-less, content-less —
 * collation skips it (the model never sees it), while the display projection
 * renders it on both surfaces from this one record.
 */
export type NotePiece = {
  kind: 'note';
  note: DisplayNote;
};

/**
 * The highest `seq` already present in a transcript file, or 0 when the file
 * is missing/empty/legacy.
 *
 * A resumed writer continues the count instead of restarting at 1: a client
 * cursor of "everything after seq N" must never be re-satisfied by records
 * that merely reuse an old number. Reads only the tail, and never throws.
 */
export function lastSeqInFile(filePath: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }
  let max = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes('"seq"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown };
      if (typeof parsed.seq === 'number' && parsed.seq > max) max = parsed.seq;
    } catch {
      // Partial trailing line / corruption — ignore; the reader counts it.
    }
  }
  return max;
}

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
/**
 * Append-only line sink: the ONE place a transcript line reaches a destination.
 *
 * The writer takes a sink rather than a path so that the destination is a
 * *dependency* (injectable, fakes-able) instead of a global: tests hand it an
 * in-memory sink and cannot touch the live `.mycc/sessions/**` transcripts, and
 * disk-full / permission failures are representable (a throwing sink) instead
 * of being un-testable. `fileLineSink()` is the production implementation; it
 * is the only thing in this module that knows about `fs`.
 */
export interface LineSink {
  /** Append exactly one already-serialised line (the sink adds its own newline handling). */
  append(line: string, encoding: 'utf-8'): void;
  /** Destination identifier for diagnostics only — never used to build a path. */
  readonly destination: string;
}

/** Production sink: one `fs.appendFileSync` per line (never seek / truncate). */
export function fileLineSink(filePath: string): LineSink {
  return {
    destination: filePath,
    append(line, encoding) {
      fs.appendFileSync(filePath, line, encoding);
    }
  };
}

/** In-memory sink for tests: nothing leaves the process. */
export function memoryLineSink(): LineSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    destination: '<memory>',
    lines,
    append(line) {
      lines.push(line);
    }
  };
}

/**
 * The display-sink contract, declared ONCE — here, next to the writer that
 * implements it.
 *
 * Both the loop (which owns the writer) and the serve layer (which renders it
 * live) need to talk about "a thing you can subscribe a display observer to".
 * Re-spelling that shape in each module produces structurally-near-identical
 * types that TypeScript refuses to unify (`(r: TranscriptRecord) => void` vs
 * `(r: unknown) => void`), so every module imports THIS one instead.
 *
 * The callback parameter is `TranscriptRecord`, written out in full: the
 * interface below IS the contract, so a `never` there would type-check while
 * telling a reader that subscribers can never be handed a record — the opposite
 * of what the writer does. (This comment previously described exactly such a
 * `never` trick; the code never did it, and the mismatch sent one review round
 * looking for a cast that does not exist.)
 */
export interface DisplayObserverHost {
  setDisplayObserver(cb: ((record: TranscriptRecord) => void) | null): void;
}

export class JsonlTranscriptWriter {
  private readonly sink: LineSink;
  private readonly filePath: string;
  private readonly onError: (err: unknown, filePath: string) => void;
  /**
   * Display-side observer: called with EVERY record that becomes a chat row
   * (a message piece or a display note), carrying the writer-stamped `seq`.
   *
   * This is how the LIVE WebSocket view is fed: the serve layer subscribes
   * here and renders the same records that /history projects from the file.
   * One record → one live frame → one history row, all sharing one `seq`, so
   * the stream itself (not a second in-memory log) is what the browser sees.
   *
   * Unset for writers that serve no browser (teammate workers). Observers must
   * never throw — the never-throws contract covers them (see append()).
   */
  private onDisplay: ((record: TranscriptRecord) => void) | null = null;
  /**
   * Monotonic per-file sequence, stamped on every record.
   *
   * The ONE identity both surfaces share: a live WS frame and the /history row
   * for the same record carry the same `seq`, so a reconnecting client can ask
   * for "everything after seq N" (the cursor) instead of relying on arrival
   * order and per-arrival client ids. Starts at 1 and only ever increases
   * within a process; a restarted process re-reads the file tail to continue
   * the count (see {@link lastSeqInFile}).
   */
  private nextSeq: number;

  /**
   * @param sinkOrPath - a {@link LineSink} (preferred: inject a fake in tests) or
   *   a file path, kept for source compatibility at the existing call sites.
   * @param onError - observed write failures; the writer itself never throws.
   * @param startSeq - first sequence number to stamp (default: continue after
   *   the highest `seq` already in the file, so a resumed session never reuses
   *   an identity the client has already rendered).
   */
  constructor(sinkOrPath: LineSink | string, onError?: (err: unknown, filePath: string) => void, startSeq?: number) {
    this.sink = typeof sinkOrPath === 'string' ? fileLineSink(sinkOrPath) : sinkOrPath;
    this.filePath = this.sink.destination;
    this.onError = onError ?? (() => {});
    this.nextSeq = startSeq ?? 1;
  }

  /** The next sequence number this writer will stamp (diagnostics/tests). */
  get sequence(): number {
    return this.nextSeq;
  }

  /** The transcript file this writer appends to. */
  get destination(): string {
    return this.filePath;
  }

  /**
   * Subscribe to the display stream — every DURABLE record that can become a
   * chat row, with its `seq`. Pass null to detach.
   *
   * The serve layer points this at the WebSocket fan-out, which makes the
   * socket a projection of the same records /history projects from the file:
   * one journal, two renderers.
   */
  setDisplayObserver(observer: ((record: TranscriptRecord) => void) | null): void {
    this.onDisplay = observer;
  }

  /**
   * Append exactly one flat record line. `message` is the piece (already
   * stamped with kind/user_origin by the facade's dispatcher — a
   * 'new'/'merge' message piece, a 'user'/'steer' user-input journal record,
   * a bare boundary piece { kind:'clear'|'compact'|'rollback' }, or a
   * { kind:'note', note } display note); the timestamp and monotonic `seq`
   * are added here at write time (single clock, single counter).
   *
   * @returns true when the line reached the sink. A `false` tells the caller
   *   the record is NOT durable — the caller may then keep its own copy
   *   (the serve hub's live mirror) instead of losing what was printed.
   */
  append(message: AppendablePiece | ControlPiece | NotePiece): boolean {
    const piece = message as Record<string, unknown>;
    const { kind, user_origin, ...messageFields } = piece;
    void user_origin;
    const record: TranscriptRecord = {
      ...messageFields,
      kind: (kind ?? 'new') as PieceKind,
      ...(user_origin !== undefined ? { user_origin: true } : {}),
      timestamp: Date.now(),
      seq: this.nextSeq
    };
    try {
      this.sink.append(`${JSON.stringify(record)}\n`, 'utf-8');
    } catch (err) {
      try {
        this.onError(err, this.filePath);
      } catch {
        // Observers must never break the writer (the never-throws contract).
      }
      return false; // sequence NOT consumed — the record was never written
    }
    this.nextSeq++;
    // The record is durable — tell the display stream about it, carrying the
    // stamp it was written with. Boundary records (clear/compact/rollback/
    // segment-archive) are journal marks, not chat rows, so they are not
    // forwarded; every other kind is (a note becomes a row, a message piece
    // may or may not, but the display projection decides, not the writer).
    if (this.onDisplay && !isControlKind(record.kind) && record.kind !== 'merge') {
      try {
        this.onDisplay(record);
      } catch {
        // An observer must never break the writer (the never-throws contract).
      }
    }
    return true;
  }

  /**
   * Journal a DISPLAY NOTE — a line the terminal printed that is not an LLM
   * message (agentIO.brief). Role-less and content-less by construction, so
   * no message projection can mistake it for input or an assistant turn;
   * /history and the terminal render it from this record.
   */
  note(note: DisplayNote): boolean {
    return this.append({ kind: 'note', note } as NotePiece);
  }

  /**
   * Journal a boundary mark (a live-log truncation/boundary: clear / compact
   * / rollback). One flat `{ kind, timestamp }` line — no message
   * fields, the event name IS the kind (conflated). Same error policy as
   * append() (never throws).
   */
  control(event: ControlEvent): void {
    this.append({ kind: event } as ControlPiece);
  }
}
