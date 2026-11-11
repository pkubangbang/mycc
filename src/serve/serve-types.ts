/**
 * serve-types.ts - Shared TypeScript interfaces for the /serve Web UI stack
 *
 * Extracted from serve-hub.ts so the extracted modules (serve-clients,
 * serve-history, serve-ws-handler, ...) can reference these types without
 * importing the heavy serve-hub.ts module graph (Express + Vite + agent-io).
 */

/**
 * A single entry in the in-memory message log and /history response.
 *
 * The `type` field is the WS message discriminator consumed by the frontend's
 * `applyServerMessage` (e.g. 'log' | 'warn' | 'error' | 'result' | 'prompt' |
 * 'system' | 'user' | 'card').
 */
export interface LogEntry {
  type: string;
  content: string;
  /** Optional — omitted for transcript-loaded entries that carry no time. */
  timestamp?: number;
  /**
   * Monotonic transcript sequence this row was projected from (see
   * `JsonlTranscriptWriter`). The WebUI keeps the highest value it has rendered
   * as its cursor, so a live frame and its /history row are the same identity
   * and a reconnect can ask for "everything after seq N". Absent for transient
   * rows (cards, prompts, state flags) that have no transcript record.
   */
  seq?: number;
  label?: string;
  /** Tool intent/description (e.g. "RUN USER TO list files"). Outlined in the bubble. */
  detail?: string;
  /** Machine-originated brief (hook engine, debug evaluator
   *  bookkeeping). The WebUI hides these from the chat log; the terminal
   *  keeps printing them. Omitted for normal messages. */
  synthetic?: boolean;
  /**
   * STRUCTURED crossroad card — the drafted directions, the winner and the
   * resolved outcome, attached to the single crossroad note.
   *
   * Why attached rather than a separate wire type: `brief()` already owns the
   * one mirroring path to the WebUI, and a separate event would have to be
   * replayed and ordered against the note it describes. Carrying the payload
   * alongside keeps the note self-contained — a client that ignores it still
   * renders `content`, and a client that understands it renders rows.
   *
   * Shape is the flat CrossroadCardWire contract from
   * src/loop/crossroad-card.ts (kept structural here to avoid a web→loop
   * import from the serve layer).
   */
  /**
   * A journaled interactive CARD row. Present only on rows projected from a
   * note record that carried a card payload (see `JsonlTranscriptWriter.note()`
   * and `projectDisplayRecord`), so a pending card survives a page reload
   * instead of leaving the agent blocked on a question nobody can see.
   */
  card?: CardMessage;
  crossroad?: {
    kind: 'crossroad';
    drafted: number;
    chosenIndex: number;
    candidates: Array<{ index: number; direction: string; preview: string; selected: boolean }>;
    outcome: string;
    /** The turning segment that was replaced; '' when absent. */
    cutpoint: string;
  };
}

/** Metadata for a file uploaded via the chat box (raw, over the wire). */
export interface FileUploadMeta {
  filename: string;
  data: string;
  mimeType: string;
}

/** Incoming WebSocket message from a client (the parsed WsMessage shape). */
export interface WsMessage {
  type: 'input' | 'exit' | 'restart-webui' | 'interrupt' | 'card-response' | 'steer' | 'steer-resolve' | 'auto';
  text?: string;
  cardId?: string;
  value?: string;
  files?: FileUploadMeta[];
  /** Steering note ids the client wants to SEND (boomerang resolve). */
  sendIds?: number[];
}

/** A file upload entry buffered in the queue (decoded from FileUploadMeta). */
export interface FileUploadEntry {
  filename: string;
  data: string;
  mimeType: string;
  text?: string;
}

/** A structured interactive card sent to the web UI (replaces ask() prompt). */
export interface CardMessage {
  type: 'card';
  cardId: string;
  query: string;
  kind: 'input' | 'confirm' | 'choice' | 'notice';
  options?: { label: string; value: string; isDefault?: boolean }[];
  initialContent?: string;
  placeholder?: string;
}
