/**
 * serve-clients.ts - WebSocket client registry + message fan-out
 *
 * Encapsulates the connected-client set and ALL WebSocket send loops that were
 * previously scattered across ServeHub methods (broadcast, broadcastCard,
 * broadcastAuto, setAgentRunning, pushSteer's steer-echo, stop's close loop,
 * onDisconnectTimeout's clear). Centralising fan-out here means the broadcast
 * boundary (ANSI stripping, message-log push, OPEN-state guard) has one
 * implementation, and the new `broadcastExcept` (multi-browser user-bubble
 * sync) lives next to its sibling.
 */
import { WebSocket } from 'ws';
import { stripAnsi } from './serve-utils.js';
import type { LogEntry } from './serve-types.js';

/** Capped in-memory log for reconnect replay (sibling of ServeHub.messageLog). */
export interface MessageLogHolder {
  push(entry: LogEntry): void;
  length: number;
  shift(): LogEntry | undefined;
}

const MAX_LOG_SIZE = 1000;

export class ClientRegistry {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
  }

  remove(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /** Alias for remove() — mirrors the Set API callers used before extraction. */
  delete(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Invoke `fn(ws)` for every OPEN client. Used by callers that send a
   * bespoke payload (e.g. a CardMessage object, a steer-echo with steerId)
   * that cannot go through the flat-string {@link broadcast} path. The
   * OPEN-state guard and try/catch live here so callers stay terse.
   */
  forEachOpen(fn: (ws: WebSocket) => void): void {
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { fn(ws); } catch { /* ignore individual send errors */ }
      }
    }
  }

  /** Close every connection and clear the set (stop / suspend-resume). */
  closeAll(): void {
    for (const ws of this.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  /** Send a raw JSON string to a single client (no stripping, no logging). */
  sendTo(ws: WebSocket, payload: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }

  /**
   * Broadcast an output message to all connected clients and append to the
   * message log (for reconnect replay).
   *
   * @param type - WS message type ('log' | 'warn' | 'error' | 'result' | 'prompt' | 'system')
   * @param content - message text (ANSI codes are stripped before send/store)
   * @param label - optional tool/module tag (e.g. 'bash', 'brief', 'question',
   *               'assistant'). Plain verbose logs pass no label.
   * @param detail - optional tool intent/description (e.g. bash command
   *                purpose). Rendered as an outlined box inside the bubble.
   * @param log - the message log to append to (ServeHub.messageLog). Omit for
   *             transient messages (auto/running flags) that must not pollute /history.
   */
  broadcast(
    type: string,
    content: string,
    label?: string,
    detail?: string,
    log?: MessageLogHolder,
  ): void {
    const cleanContent = stripAnsi(content);
    // detail (e.g. the `id:` line on a checkpoint brief) also carries chalk
    // color codes from the caller — strip it too so no field leaks ANSI into
    // the Web UI. Mirrors the cleanContent treatment above.
    const cleanDetail = detail ? stripAnsi(detail) : detail;
    const timestamp = Date.now();
    if (log) {
      const entry: LogEntry = { type, content: cleanContent, timestamp };
      if (label) entry.label = label;
      if (cleanDetail) entry.detail = cleanDetail;
      log.push(entry);
      if (log.length > MAX_LOG_SIZE) {
        log.shift();
      }
    }
    const payload = JSON.stringify({ type, content: cleanContent, label, timestamp, detail: cleanDetail || undefined });
    for (const ws of this.clients) {
      this.sendTo(ws, payload);
    }
  }

  /**
   * Broadcast a message to all connected clients EXCEPT the sender. Used for
   * user-query/steer echo so the sending client (which already has a local
   * optimistic bubble via sendInput/sendSteer in main.ts) doesn't get a
   * duplicate.
   *
   * Never logged to the message log — user bubbles are persisted via
   * appendUserLog() to the durable user-log JSONL, and logging here would
   * duplicate them on /history (messageLog + userLog merge).
   */
  broadcastExcept(
    sender: WebSocket,
    type: string,
    content: string,
    label?: string,
    detail?: string,
  ): void {
    const cleanContent = stripAnsi(content);
    const cleanDetail = detail ? stripAnsi(detail) : detail;
    const timestamp = Date.now();
    const payload = JSON.stringify({ type, content: cleanContent, label, timestamp, detail: cleanDetail || undefined });
    for (const ws of this.clients) {
      if (ws === sender) continue;
      this.sendTo(ws, payload);
    }
  }
}