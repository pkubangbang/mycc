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
  label?: string;
  /** Tool intent/description (e.g. "RUN USER TO list files"). Outlined in the bubble. */
  detail?: string;
}

/** Metadata for a file uploaded via the chat box (raw, over the wire). */
export interface FileUploadMeta {
  filename: string;
  data: string;
  mimeType: string;
}

/** Incoming WebSocket message from a client (the parsed WsMessage shape). */
export interface WsMessage {
  type: 'input' | 'exit' | 'interrupt' | 'card-response' | 'steer' | 'steer-resolve' | 'auto';
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
  kind: 'input' | 'confirm' | 'choice';
  options?: { label: string; value: string; isDefault?: boolean }[];
  initialContent?: string;
  placeholder?: string;
}