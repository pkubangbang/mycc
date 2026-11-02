/**
 * wire-codec.ts — the ONE place that knows the filesync wire format
 * (architect review R3+R4). Owns:
 *
 *   - the control-frame verb fold: engine `t:'index'|...` ⇄ wire
 *     `type:'sync-index'|...` (sendSyncControl's fold + toSyncControl's
 *     inverse, previously hand-kept in wire-registry with a mirror type +
 *     double casts),
 *   - the binary data-frame codec (re-exported from frames.ts so the wire
 *     plane never imports frames.ts directly),
 *   - `isSyncControlFrame` / `trySyncDispatch` / `trySyncDataDispatch` —
 *     the shared dispatch helpers both wire sites (wire-client + peer-wire)
 *     call, killing their copy-pasted branches,
 *   - `handlePeerShares` — the announce-shares ordering (recordPeerShares
 *     THEN kick the gossip hook) done once; `clearPeerShares` deliberately
 *     does NOT fire the hook (teardown is not membership gossip).
 *
 * The sync-* verbs + the 0x04 datagram are filesync PROTOCOL, so they live
 * here (feature-owned), not in wire-registry (which keeps only sockets).
 * Structural boundary: this module imports only `./frames.js` (types/codec)
 * and `../wire-registry.js` (sockets) — never the manager/engine, so there
 * is no value cycle; the wire plane reaches the engine through the injected
 * WireHooks callbacks (R5), not through this codec.
 */

import type { WebSocket } from 'ws';
import {
  decodeDataFrame, encodeDataFrame,
  type SyncControlFrame, type SyncDataFrame,
} from './frames.js';
import {
  recordPeerShares, peerSidForSocket, findSocketBySid,
  type SyncControlFrameShape,
} from '../wire-registry.js';

export { encodeDataFrame, decodeDataFrame };
export type { SyncDataFrame };

/** The wire `type` tags for filesync control frames. */
const SYNC_TYPES = new Set(['sync-index', 'sync-req', 'sync-pieces', 'sync-del', 'sync-err']);
type SyncVerb = 'index' | 'req' | 'pieces' | 'del' | 'err';

/** Is this a filesync control frame (the onMessage dispatch predicate —
 *  previously copy-pasted as a 5-way `||` at both wire sites)? */
export function isSyncControlFrame(frame: { type?: string }): frame is SyncControlFrameShape {
  return typeof frame.type === 'string' && SYNC_TYPES.has(frame.type);
}

/** Engine `t` ⇄ wire `type` fold. `foldControl` is used on the send path
 *  (sendSyncControl); `unfoldControl` on the receive path. */
export function foldControl(payload: Record<string, unknown>): Record<string, unknown> {
  const verb = String(payload.t ?? 'err');
  const { t: _t, ...rest } = payload;
  void _t;
  return { type: `sync-${verb}`, share: payload.share, ...rest };
}

export function unfoldControl(frame: SyncControlFrameShape): SyncControlFrame {
  const t = frame.type.replace('sync-', '') as SyncVerb;
  const { type: _type, ...rest } = frame as unknown as Record<string, unknown>;
  void _type;
  return { t, ...(rest as object) } as unknown as SyncControlFrame;
}

/**
 * The narrow behavior surface the wire plane calls into the engine through
 * (R5). Injected as lazy closures on WireHooks so boot order never matters
 * (the getShares precedent). Kept here as the contract the dispatch helpers
 * consume — the wire site supplies these from its hooks.
 */
export interface SyncDispatchTarget {
  onControlFrame(peer: string, frame: SyncControlFrame): void;
  onDataFrame(peer: string, frame: SyncDataFrame): void;
  onPartnerShares(peer: string, shares: string[]): void;
}

/** Dispatch a raw TEXT wire frame if it is filesync control. Returns true
 *  when handled (so the caller's unknown-type fall-through stays correct). */
export function trySyncDispatch(target: SyncDispatchTarget | null, peer: string | null, frame: unknown): boolean {
  if (!target || !peer) return false;
  if (!isSyncControlFrame(frame as { type?: string })) return false;
  target.onControlFrame(peer, unfoldControl(frame as SyncControlFrameShape));
  return true;
}

/** Dispatch a raw BINARY WS frame if it is a filesync data frame. Returns
 *  true when handled. */
export function trySyncDataDispatch(target: SyncDispatchTarget | null, peer: string | null, buf: Buffer): boolean {
  if (!target || !peer) return false;
  const df = decodeDataFrame(buf);
  if (!df) return false;
  target.onDataFrame(peer, df);
  return true;
}

/**
 * Announce-shares handling (R3): record the peer's membership THEN kick the
 * gossip hook (immediate index exchange for shared shares). Done once here;
 * both wire sites call it. `clearPeerShares` (teardown) deliberately does
 * NOT fire this hook — dropping membership is not a gossip event.
 */
export function handlePeerShares(target: SyncDispatchTarget | null, sid: string, shares: string[] | undefined): void {
  recordPeerShares(sid, shares);
  target?.onPartnerShares(sid, shares ?? []);
}

/** Convenience: resolve the peer sid for a socket (re-exported so the wire
 *  sites don't import wire-registry's reverse lookup separately). */
export { peerSidForSocket };
export type { WebSocket };

/**
 * Send a filesync CONTROL frame to a peer sid (R6: the send path lives here
 * with the fold, so the format is owned in one module and wire-registry
 * keeps only sockets). Byte-aware guard rejects an oversize frame BEFORE
 * sending (1009 storm avoidance).
 */
export function sendSyncControl(targetSid: string, payload: Record<string, unknown>): boolean {
  const socket = findLiveSocket(targetSid);
  if (!socket) return false;
  const frame = JSON.stringify(foldControl(payload));
  if (Buffer.byteLength(frame) > WIRE_MAX_PAYLOAD_BYTES) return false;
  try { socket.send(frame); return true; } catch { return false; }
}

/** Send a filesync binary DATA frame (already-encoded piece bytes) to a peer. */
export function sendSyncData(targetSid: string, buf: Buffer): boolean {
  const socket = findLiveSocket(targetSid);
  if (!socket) return false;
  if (buf.length > WIRE_MAX_PAYLOAD_BYTES) return false;
  try { socket.send(buf, { binary: true }); return true; } catch { return false; }
}

/** The live open socket for a sid — delegated to the wire-registry's socket
 *  census (wire-registry owns sockets; this module owns the format). */
function findLiveSocket(targetSid: string): WebSocket | null {
  return findSocketBySid(targetSid);
}

/** Same byte cap the wire applies to mail frames (sendWireMail pattern). */
const WIRE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
