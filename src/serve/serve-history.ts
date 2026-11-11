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
import {
  readTranscript,
  lastSeqInFile,
  isControlKind,
  type DisplayNote,
  type TranscriptRecord
} from '../loop/triologue/transcript.js';

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
  steeringRevision: number,
  isRunning: boolean,
  messageLog?: readonly LogEntry[],
  transcriptHasRecords?: boolean,
  lastSeq?: number
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
  // The DISPLAY CURSOR: the highest journal `seq` the file holds.
  //
  // TWO WITNESSES, DISJOINT BLIND SPOTS — do not drop either:
  //   - `stat` (above) is the DURABILITY witness: did the bytes actually land? A
  //     torn trailing line is parse-SKIPPED, so `seq` below is unchanged while the
  //     file grew; only mtimeMs/size can see that.
  //   - `seq` is the IDENTITY witness: how many records exist? It states directly
  //     what "was anything journaled while the socket was opening?" needs, which
  //     the coarse stat pair only approximates.
  // Together they are SUFFICIENT, not redundant. Dropping the stat after noticing
  // `seq` exists reopens a window where a 304 pins a body missing its last line —
  // and nothing later invalidates it, because that tail never parsed.
  //
  // This is what makes the client's post-open revalidation correct (see
  // lastRenderedSeq in src/web/src/main.ts). A serve with no transcript yet
  // contributes 0 (stable, so it cannot flap).
  // The fallback below is a LATENT TRAP, not a convenience: it re-reads the file
  // AFTER the caller already read it for the body, so an omitted `lastSeq` yields
  // an ETag describing a different file state than the body it guards — the exact
  // false-304 mechanism this single-pass refactor removed, preserved as a trap for
  // the next caller. Every production caller passes `lastSeq`; this stays only so
  // pre-existing 3-arg test fixtures keep compiling, and it warns so nobody
  // reaches it unwittingly. Deleting `lastSeqInFile` is NOT the fix: agent-repl.ts
  // uses it for the writer's startSeq resume path.
  let resolvedSeq = 0;
  if (transcriptPath) {
    if (lastSeq === undefined) {
      // eslint-disable-next-line no-console -- deliberate: a silent fallback is the bug
      console.warn(
        '[serve-history] computeHistoryVersion called without lastSeq — re-reading the transcript (ETag/body skew window). Pass the max seq from the caller\u2019s own read.'
      );
      resolvedSeq = lastSeqInFile(transcriptPath);
    } else {
      resolvedSeq = lastSeq;
    }
  }
  parts.push(`seq:${resolvedSeq}`);
  // Transient fields that live in the body but NOT in the durable files.
  // The steering queue is folded in by REVISION, not by length: a drain that
  // removes one note while another arrives keeps the length identical but
  // changes the set the client must adopt (see the revisioned-snapshot note
  // in src/loop/steering-manager.ts).
  parts.push(`steer:${steeringRevision}`);
  parts.push(`running:${isRunning ? 1 : 0}`);
  // THE FALLBACK WINDOW: while the transcript holds no records, /history's BODY
  // is the in-memory messageLog (see readHistory's predicate), and that log is
  // appendable by broadcast()/broadcastCard() without touching any file. Without
  // a folded-in term the ETag would be constant across such appends, and a
  // client holding it would get a 304 for a body it has never seen — a frozen
  // chat until something else changed. Gated on the SAME predicate readHistory
  // uses (`transcriptHasRecords`, computed once per GET by the caller), so the
  // tag and the body always agree about which source is live.
  if (transcriptHasRecords === false) {
    const last = messageLog && messageLog.length > 0 ? messageLog[messageLog.length - 1] : undefined;
    parts.push(`log:${messageLog?.length ?? 0}:${last?.timestamp ?? 0}`);
  }
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
    case 'user':
      return 'user';
    case 'assistant':
      return 'result';
    case 'tool':
      return 'log';
    case 'system':
      return 'system';
    default:
      return 'log';
  }
}

/**
 * Map a triologue Message role to a WebUI display label (shown as
 * [HH:MM:SS] [label] in the UI, mirroring the terminal brief header).
 */
export function roleToLabel(role: string | undefined): string | undefined {
  switch (role) {
    case 'assistant':
      return 'assistant';
    case 'tool':
      // The `tool` label is load-bearing, not cosmetic: the WebUI's "详细日志"
      // toggle hides UNLABELED log/warn/error entries (isMessageVisible in
      // src/web/src/main.ts), so an unlabeled tool turn — roleToType() projects
      // it to 'log' — vanishes from the chat on every /history reload even
      // though the live broadcast() path shows it with its tool-name label.
      return 'tool';
    case 'user':
      return undefined; // user bubbles already align right
    default:
      return undefined; // unlabelled system logs: hidden when verbose off
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
/**
 * Project ONE transcript record onto its WebUI chat row — the row rule shared
 * by the history endpoint (`projectDisplay`, over the file) and the live
 * WebSocket fan-out (over each record as it is journaled).
 *
 * Keeping the rule in one function is the point: a live row and a replayed row
 * come from the same record through the same code, so a refresh cannot change
 * what a message looks like, and it cannot appear twice.
 *
 * @param record - a transcript record (file-loaded or freshly journaled)
 * @param knownTimestamp - highest positive timestamp seen so far in this
 *        stream, for the emission-order inheritance of untimestamped legacy
 *        lines (see projectDisplay). Not mutated here.
 * @returns the chat row, or null when the record is not a chat row.
 */
export function projectDisplayRecord(record: TranscriptRecord, knownTimestamp?: number): LogEntry | null {
  const seq = typeof record.seq === 'number' ? record.seq : undefined;
  const stamp = (row: LogEntry): LogEntry => {
    if (typeof record.timestamp === 'number' && record.timestamp > 0) {
      row.timestamp = record.timestamp;
    } else if (knownTimestamp !== undefined) {
      row.timestamp = knownTimestamp;
    } else {
      row.timestamp = 0;
    }
    if (seq !== undefined) row.seq = seq;
    return row;
  };

  const note = record.kind === 'note' ? (record.note as DisplayNote | undefined) : undefined;
  if (note) {
    // Synthetic notes are operational-only: both surfaces hide them, and the
    // client cannot (a labelled row always shows), so drop it HERE.
    if (note.synthetic) return null;
    // TERMINAL ECHO of a journaled message: the same paragraph is already a
    // message record (kind 'new') that projects to its own row, so drawing this
    // note too put ONE assistant turn on screen TWICE — once as the message row
    // (with its actions) and once as a copy without them. Reported live, and
    // reproduced from a real transcript: seq 81 (message) and seq 82 (note) in
    // triologue-lead-1794363794.jsonl carried identical text.
    //
    // Gated on the flag, not on content equality: the two records are normalised
    // independently (DSML/ANSI stripping), so a text match is a heuristic that
    // drifts, while the producer knows exactly what it is echoing.
    if (note.echoOf === 'message') return null;
    // A CARD is a note carrying a `card` payload: an interactive widget that
    // must survive a reload exactly like chat text does. It is journaled as a
    // note (one record, one row) rather than replayed from the serve-lifetime
    // log, so a pending card cannot silently vanish and leave the agent blocked
    // on a question the browser can no longer show.
    const card = note.card;
    if (card) {
      // Rebuilt field-by-field, not spread: the file is untrusted input, so the
      // row can carry ONLY the members of the card contract — a stray extra key
      // in the journal must not reach the client's renderer.
      const cardRow: LogEntry = {
        type: 'card',
        content: stripAnsi(note.text),
        card: {
          type: 'card',
          cardId: card.cardId,
          query: card.query,
          kind: card.kind,
          ...(card.options !== undefined ? { options: card.options } : {}),
          ...(card.initialContent !== undefined ? { initialContent: card.initialContent } : {}),
          ...(card.placeholder !== undefined ? { placeholder: card.placeholder } : {})
        }
      };
      return stamp(cardRow);
    }
    // A note's body lives in `note.text` (never `content`) so the message
    // projections cannot claim it; the row type mirrors brief()'s level.
    const type = note.level === 'error' ? 'error' : note.level === 'warn' ? 'warn' : 'log';
    const row: LogEntry = { type, content: stripAnsi(note.text), label: note.tool };
    if (note.detail) row.detail = note.detail;
    if (note.crossroad) row.crossroad = note.crossroad as LogEntry['crossroad'];
    return stamp(row);
  }
  if (isControlKind(record.kind) || record.kind === 'merge') return null;
  const role = typeof record.role === 'string' ? record.role : undefined;
  if (role === undefined) return null; // injected/role-less record — not a bubble
  if (role === 'user' && record.user_origin !== true) return null; // injected note
  if (role === 'tool') return null; // tool activity is shown as brief notes, not raw results
  if (typeof record.content !== 'string' || record.content === '') return null;
  const row: LogEntry = { type: roleToType(role), content: stripAnsi(record.content) };
  const label = roleToLabel(role);
  if (label) row.label = label;
  // Carry `synthetic` onto MESSAGE rows too, not just notes. The live socket and
  // /history must hide the same rows: a machine-originated line hidden live but
  // shown after a reload is exactly the parity break users report as "the
  // refresh shows garbage the chat did not".
  if (record.synthetic === true) row.synthetic = true;
  return stamp(row);
}

/**
 * Project a transcript file onto WebUI chat rows — the DISPLAY projection.
 *
 * This is the only place that decides what a record looks like on screen, and
 * BOTH surfaces are meant to render from it. It is deliberately separate from
 * `collateMessages()` (the LLM-context projection, which folds user fragments
 * and skips role-less records): display identity is per RECORD, so folding
 * would merge two rows the user saw as two.
 *
 * Row rules: see {@link projectDisplayRecord} (shared with the live socket).
 *
 * Order is FILE ORDER (position), which is also the writer's `seq` order — the
 * stream itself is the sort key, so no timestamp merge can reorder (or
 * duplicate) a record, and no cap can truncate one. Records written before
 * `seq` existed keep file order too; an UNTIMESTAMPED legacy line inherits the
 * last positive timestamp seen so far (emission order, pitfall 8547e85b) —
 * this only matters for the timestamp LABEL, never for row order.
 */
export function projectDisplay(transcriptPath: string | null): LogEntry[] {
  if (!transcriptPath) return [];
  try {
    return projectDisplayRecords(readTranscript(transcriptPath).records);
  } catch {
    return [];
  }
}

/**
 * Project ALREADY-PARSED records onto rows — the same walk as {@link projectDisplay},
 * so a caller that has read the file for another reason (the /history route's
 * ETag) does not pay for a second full read and parse.
 */
export function projectDisplayRecords(records: readonly TranscriptRecord[]): LogEntry[] {
  const rows: LogEntry[] = [];
  // Emission-order timestamp normalisation (pitfall 8547e85b): an untimestamped
  // legacy line inherits the last POSITIVE timestamp seen so far, so it can
  // never claim "epoch 0". A leading untimestamped run stays at 0 — there is no
  // earlier record to inherit from. This only affects the rendered time; row
  // ORDER is file order and is never recomputed from timestamps.
  let knownTimestamp: number | undefined;
  for (const record of records) {
    const row = projectDisplayRecord(record, knownTimestamp);
    if (typeof record.timestamp === 'number' && record.timestamp > 0) {
      knownTimestamp = record.timestamp;
    }
    if (row) rows.push(row);
  }
  return rows;
}

/** Highest `seq` in a parsed record set (0 when none carry one). */
export function maxSeqOfRecords(records: readonly TranscriptRecord[]): number {
  let max = 0;
  for (const r of records) {
    if (typeof r.seq === 'number' && Number.isFinite(r.seq) && r.seq > max) max = r.seq;
  }
  return max;
}

/** Parse the transcript once for a caller that needs count, max seq AND rows. */
export function readTranscriptRecords(transcriptPath: string): TranscriptRecord[] {
  try {
    return readTranscript(transcriptPath).records;
  } catch {
    return []; // unreadable file → treat as not-yet-journaled
  }
}

/**
 * Reconstruct the full chat history for the /history endpoint.
 *
 * The transcript is the SINGLE source: every printed chat line is journaled
 * there (user input as a user journal record, assistant replies as message
 * pieces, brief/status lines as display notes), so this projects the file and
 * nothing else. `messageLog` is no longer a history source — merging it with a
 * projection of the same turns is what shipped one turn as two identical cards.
 *
 * THE FALLBACK CONDITION IS "the transcript contains NO RECORDS", NOT "the
 * projection produced no rows", and not "there is no transcript path". All
 * three look alike and only one is correct:
 *
 *   - "no path" is wrong: `writeFreshSessionFiles` creates the transcript file
 *     at boot, before serve can ever start, so a serve coming up in that window
 *     already holds a path to an EMPTY file. Keying on the path would project
 *     zero rows and silently drop every turn recorded before the first journal
 *     line — a bubble that appears zero times.
 *   - "projection produced no rows" is ALSO wrong, and worse because the bug is
 *     invisible until it matters: a transcript holding only tool records, notes
 *     that are all synthetic, injected user notes or boundary marks is a normal,
 *     populated transcript that happens to draw nothing. Treating it as empty
 *     would resurrect a stale serve-lifetime log over a real journal.
 *   - "no records" is the actual question: has this file ever journaled
 *     anything? Once it has, it owns the history outright.
 *
 * Keying on emptiness keeps the two sources disjoint by CONSTRUCTION rather than
 * by hope: the log is consulted only while the file is literally empty, and the
 * instant it holds a record the log is out of the picture for good.
 *
 * KNOWN RESIDUAL DEFECT (recorded, not fixed here): a turn that only ever
 * reached the serve-lifetime log is visible while the transcript is empty and
 * VANISHES when the first record lands. That is a silent visibility REGRESSION —
 * worse than a stable zero, because a refresh makes a message the user just saw
 * disappear. Making such turns live exactly once end-to-end requires either
 * transferring the log tail into the transcript at that boundary or a
 * timestamp-keyed union-dedup in projectDisplay; both are separate designs that
 * must be reviewed on their own. Reported to the peer as a KNOWN DEFECT, not as
 * solved.
 *
 * WHY THE PREDICATE MUST NOT BE "there is no transcript path". The window is
 * real, and it is reached on EVERY serve start, which is why the tempting
 * shortcut silently loses turns:
 *
 *     initializeSession() → writeFreshSessionFiles()  creates
 *       triologue-lead-<sec>.jsonl with an EXCLUSIVE 'wx' open, leaving a
 *       PRESENT but ZERO-BYTE file;
 *     activateServe()                               runs afterwards.
 *
 * So by the time serve can answer /history, `transcriptPath` is non-null and
 * already points at an existing file. A predicate on existence (or on "no
 * path") therefore reads an EMPTY transcript as authoritative and projects zero
 * rows — every turn recorded before the first journal line is dropped from the
 * body instead of falling back to the log. Only RECORD COUNT answers the real
 * question ("has this file journaled anything yet?"), so it is the predicate
 * for BOTH decisions: the body below and the `transcriptHasRecords` term in
 * computeHistoryVersion.
 *
 * AND THE UPPER BOUND OF THE DOUBLE-ROW FLICKER — read this before claiming the
 * window is harmless. Once the first record lands, the file owns the body and
 * the fallback stops supplying rows, but the BROWSER may still be holding a
 * fallback row it rendered moments earlier from a socket frame or an older
 * snapshot. Fallback rows carry NO `seq` (they are messageLog entries), so the
 * client's identity gate (isAlreadyRendered / mergeSnapshot in
 * src/web/src/display-cursor.ts) has nothing to compare and cannot recognise
 * the journaled row as the same line. Consequence: the SAME line can be visible
 * TWICE for as long as it takes the next authoritative /history 200 to replace
 * the store — i.e. until the socket's post-open revalidation or a page reload,
 * bounded by that round-trip and by nothing else. The record-count keying only
 * guarantees the duplicate "obviously goes away"; it does NOT prevent it from
 * appearing. That is a FLICKER, not a fix, and the 4/4 agreement between the two
 * projections does not extend past it.
 *
 * A real fix must give fallback rows an identity the journal can match (a
 * synthetic seq namespace, or transferring the log tail into the transcript at
 * the boundary). Both change the wire contract, so neither belongs here.
 *
 * RELATED ACCEPTANCE CONSTRAINT (e) — a LEGACY ETag must never answer 304. A
 * client that cached a snapshot under a pre-`seq` fingerprint (the format before
 * computeHistoryVersion folded `seq:` in, and before `log:` became conditional)
 * can present that token in If-None-Match. The current formula folds different
 * inputs, so the tags cannot collide and the route answers 200 with the FULL
 * body; a 304 there would hand the client an empty response it cannot merge
 * into the stale log, freezing the chat with no path forward except a reload.
 * Changing the ETag input set is therefore a breaking change for old clients
 * ONLY in the safe direction, and any future edit to those inputs must preserve
 * that direction.
 *
 * @param transcriptPath - durable triologue JSONL path
 * @param messageLog     - serve-lifetime log; consulted only while the
 *                         transcript has journaled nothing at all
 */
export function readHistory(transcriptPath: string | null, messageLog: LogEntry[]): LogEntry[] {
  if (transcriptPath) {
    // Record count, not row count: see the predicate note above — a populated
    // transcript that projects to no rows must NOT fall back. Counted through
    // countTranscriptRecords so a caller can ask the SAME question for its ETag.
    let records: TranscriptRecord[] = [];
    try {
      if (countTranscriptRecords(transcriptPath) > 0) records = readTranscript(transcriptPath).records;
    } catch {
      records = []; // unreadable file → treat as not-yet-journaled
    }
    if (records.length > 0) {
      try {
        return projectDisplay(transcriptPath);
      } catch {
        // Projection failed on a populated file — fall through rather than
        // serving nothing at all.
      }
    }
  }
  return messageLog;
}

/**
 * How many records the transcript file holds (0 when absent/unreadable).
 *
 * The ONE predicate behind both questions /history asks: "does the transcript
 * own the body?" (readHistory) and "may the body still be the in-memory log?"
 * (computeHistoryVersion). Sharing it is what keeps an ETag and the body that
 * carries it from disagreeing about which source is live.
 */
export function countTranscriptRecords(transcriptPath: string | null): number {
  if (!transcriptPath) return 0;
  try {
    return readTranscript(transcriptPath).records.length;
  } catch {
    return 0;
  }
}
