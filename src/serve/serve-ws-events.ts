/**
 * serve-ws-events.ts — the hub's WebSocket server-side event handlers
 *
 * Extracted from ServeHub (behaviour-preserving): the three `ws` callbacks the
 * WS server installs for a browser connection. They are pure "hub reactions", so
 * they live here as free functions over a narrow host interface instead of three
 * more private methods on a 1500-line class.
 *
 * WHY THE HOST SHAPE IS EXPLICIT: each handler touches a different slice of the
 * hub (client registry, disconnect timer, replay state, inbound dispatch). The
 * interface spells out exactly how much of ServeHub a connection's lifecycle may
 * touch — and keeps the cycle rule visible: a close handler must NEVER re-arm the
 * reconnect timer while the stack is stopping.
 */

import type { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { agentIO } from '../loop/agent-io.js';
import type { ClientRegistry } from './serve-clients.js';
import type { DisconnectTimer } from './serve-disconnect-timer.js';

/** The hub surface a connection's lifecycle is allowed to touch. */
export interface WsEventHost {
  readonly clients: ClientRegistry;
  readonly disconnectTimer: DisconnectTimer;
  /** Whether the HTTP/WS stack is up (stop() clears it FIRST). */
  isRunning(): boolean;
  /**
   * Re-send the transient state /history does not carry to a fresh socket: the
   * blocked prompt (so the composer enables), the auto flag, the running flag
   * and the plan/normal mode. History itself is NOT replayed — the client
   * fetches /history at load, before connecting.
   */
  replayConnectionState(ws: WebSocket): void;
  /** Journal one inbound frame into the diagnostics ring (before dispatch). */
  recordInboundFrame(rawText: string): void;
  /** The diagnostics slot waiting for its outcome (cleared around dispatch). */
  clearPendingDiagFrame(): void;
  /** Route one inbound WS frame (serve-ws-handler). */
  dispatch(ws: WebSocket, rawText: string): void;
}

/**
 * Decode a ws message payload to text.
 *
 * ws types message data as RawData (Buffer | ArrayBuffer | Buffer[]), which has
 * no default string conversion worth trusting — String(rawData) can yield
 * "[object Object]" for a Buffer[]. Decode through Buffer instead.
 */
export function wsDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** A browser connected: register it, cancel the reconnect timer, sync its state. */
export function onWsConnection(host: WsEventHost, ws: WebSocket): void {
  host.clients.add(ws);
  host.disconnectTimer.cancel(); // reconnect cancels 30s timer
  host.replayConnectionState(ws);
  ws.on('message', (data) => {
    const text = wsDataToText(data);
    // Record BEFORE dispatch, sampling the input bridge at ARRIVAL — see
    // recordInboundFrame for why the sample must precede the handler
    // (submitInput consumes the resolver it is about to be judged by).
    host.recordInboundFrame(text);
    // Close the slot: a frame that never reached submitInput (steer, exit,
    // interrupt, malformed) must not leave a status pending for the NEXT one.
    host.clearPendingDiagFrame();
    host.dispatch(ws, text);
    host.clearPendingDiagFrame();
  });
  ws.on('close', () => onWsClose(host, ws));
  ws.on('error', (err) => onWsError(ws, err));
}

/**
 * A browser disconnected.
 *
 * The `isRunning()` guard is load-bearing: `stop()` closes every client, and
 * without it each close would re-arm the reconnect timer AFTER stop() already
 * cancelled it, leaving a stray timer running against a stopped server. A close
 * during shutdown is expected — skip the reconnect path entirely.
 */
export function onWsClose(host: WsEventHost, ws: WebSocket): void {
  if (!host.isRunning()) return;
  host.clients.delete(ws);
  if (host.clients.size === 0) {
    host.disconnectTimer.start();
  }
}

/** A socket-level error. Verbose only — a broken client must not break serve. */
export function onWsError(_ws: WebSocket, err: Error): void {
  agentIO.verbose('serve', `WebSocket error: ${err.message}`);
}
