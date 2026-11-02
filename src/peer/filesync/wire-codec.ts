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
  recordPeerShares, peerSidForSocket, findSocketBySid, partnersForShare,
  type SyncControlFrameShape,
} from '../wire-registry.js';
import type { SyncMessage, SyncDataMessage, PeerPort } from '@pkubangbang/filesync-manager';

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

// ── Engine message ⇄ wire frame (the adapter owned by the HOST) ───────────

/**
 * Engine message → the wire frame the peer expects. The transport-agnostic
 * engine (packages/filesync-manager) speaks `kind` messages; mycc's wire
 * speaks `type:'sync-*'`. This is the ONLY place the two vocabularies meet,
 * so the package stays free of wire verbs and the wire format stays stable.
 */
export function messageToControl(msg: SyncMessage): Record<string, unknown> {
  // Returns the ENGINE-side payload (`t` + fields) — exactly ONE fold happens,
  // in sendSyncControl. Returning an already-wire-shaped `type` object here
  // would be folded a second time (t undefined → 'err'), which silently
  // rewrote every manifest into `sync-err` while keeping the field payload.
  switch (msg.kind) {
    case 'manifest':
      return { t: 'index', share: msg.share, entries: msg.files, tombstones: msg.tombstones, conflicts: [] };
    case 'want-list':
      return { t: 'req', share: msg.share, file: msg.relPath, want: 'pieces' };
    case 'piece-list':
      return { t: 'pieces', share: msg.share, file: msg.relPath, pieceHashes: msg.pieceHashes };
    case 'want-pieces':
      return { t: 'req', share: msg.share, pieceHashes: msg.pieceHashes };
    case 'deletion':
      return { t: 'del', share: msg.share, relPath: msg.relPath, gen: msg.gen };
    case 'error':
      return { t: 'err', share: msg.share, reason: msg.reason };
  }
}

/** Wire frame → engine message (receive path). Unknown/absent verbs → null. */
export function controlToMessage(frame: SyncControlFrame): SyncMessage | null {
  switch (frame.t) {
    case 'index':
      return {
        kind: 'manifest', share: frame.share,
        files: frame.entries ?? [], tombstones: frame.tombstones ?? [],
      };
    case 'req':
      if (frame.want === 'pieces' && typeof frame.file === 'string') {
        return { kind: 'want-list', share: frame.share, relPath: frame.file };
      }
      return { kind: 'want-pieces', share: frame.share, pieceHashes: frame.pieceHashes ?? [] };
    case 'pieces':
      return { kind: 'piece-list', share: frame.share, relPath: frame.file, pieceHashes: frame.pieceHashes ?? [] };
    case 'del':
      return { kind: 'deletion', share: frame.share, relPath: frame.relPath, gen: frame.gen };
    case 'err':
      return { kind: 'error', share: frame.share, reason: frame.reason };
    default:
      return null;
  }
}

/** Wire data frame → engine piece message. */
export function dataToMessage(df: SyncDataFrame): SyncDataMessage {
  return { kind: 'piece', share: df.share, pieceHash: df.pieceHash, data: df.data };
}

/**
 * The host's implementation of the package's `PeerPort`: engine → wire,
 * pairwise (no relay — every message goes to ONE partner over its own
 * socket).
 */
export const wirePort: PeerPort = {
  // The package's port is async (backpressure contract); mycc's transport is a
  // synchronous socket send, so a failed send resolves immediately and the
  // next manifest exchange is the retry. Exactly one fold happens here, in
  // sendSyncControl.
  async sendMessage(peer: string, msg: SyncMessage): Promise<void> {
    sendSyncControl(peer, messageToControl(msg));
  },
  async sendData(peer: string, msg: SyncDataMessage): Promise<void> {
    sendSyncData(peer, encodeDataFrame(msg.share, msg.pieceHash, msg.data));
  },
  async partners(share: string): Promise<string[]> {
    return partnersForShare(share);
  },
};

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
  return sendFoldedControl(targetSid, foldControl(payload));
}

/** Send an ALREADY-folded wire frame (no second fold). */
export function sendFoldedControl(targetSid: string, wireFrame: Record<string, unknown>): boolean {
  const socket = findLiveSocket(targetSid);
  if (!socket) return false;
  const frame = JSON.stringify(wireFrame);
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
