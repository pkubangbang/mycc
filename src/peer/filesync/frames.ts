/**
 * frames.ts — the sync frame family over the existing WS socket
 * (filesync.md §3). Two classes demuxed by WS frame type:
 *
 *   - TEXT frames: JSON control (`index`, `req`, `del`, `err`) — same
 *     encoding as the existing `announce`/`mail` wire frames.
 *   - BINARY frames: `sync-data` piece payload, raw bytes (NO base64 —
 *     +33% wire waste and double memory churn otherwise):
 *       [0x04 type][32B sha256 raw][2B shareLen BE][share utf8][piece]
 *
 * The existing `announce` frame is extended with `shares: string[]`
 * (membership gossip) — a peer's share list arrives with its identity.
 *
 * Old peers parse JSON and drop unknown `type`s (wire-client/peer-wire
 * dispatch) — a `sync-*` frame is simply ignored there, which is the
 * version-skew degradation (filesync.md §3): no crash, and our `sync-index`
 * gets no reply within the 10s skew deadline → "peer has no sync support".
 */

import type { AnnounceFrame } from '../wire-registry.js';

// ── Text control frames ────────────────────────────────────────────────────

export interface SyncIndexFrame {
  t: 'index';
  share: string;
  entries: Array<{ relPath: string; gen: { mtimeMs: number; sid: string }; size: number; pieceListHash: string }>;
  tombstones: Array<{ relPath: string; gen: { mtimeMs: number; sid: string }; by: string }>;
  conflicts: Array<{ relPath: string; keptGen: { mtimeMs: number; sid: string }; loserSid: string; loserTs: number }>;
}

export interface SyncReqFrame {
  t: 'req';
  share: string;
  /** Piece hashes to fetch (sequential order preserved). */
  pieceHashes?: string[];
  /** Lazy piece-list fetch: send me the piece hashes for this file. */
  file?: string;
  want?: 'pieces';
}

/**
 * Piece-list REPLY (one-directional answer to `req{want:'pieces'}`).
 * Distinct verb so a reply is never mistaken for a fresh request — the
 * overloading of `req` for both directions caused an unbounded
 * want:"pieces" echo loop (the smoke's 60k-frame flood).
 */
export interface SyncPiecesFrame {
  t: 'pieces';
  share: string;
  file: string;
  pieceHashes: string[];
}

export interface SyncDelFrame {
  t: 'del';
  share: string;
  relPath: string;
  gen: { mtimeMs: number; sid: string };
}

export interface SyncErrFrame {
  t: 'err';
  share?: string;
  reason: string;
}

export type SyncControlFrame = SyncIndexFrame | SyncReqFrame | SyncPiecesFrame | SyncDelFrame | SyncErrFrame;

// ── Binary data frame ──────────────────────────────────────────────────────

export const SYNC_DATA_TYPE = 0x04;
const HASH_LEN = 32;
const SHARE_LEN_BYTES = 2;

export interface SyncDataFrame {
  t: 'data';
  share: string;
  /** sha256 hex of the piece bytes. */
  pieceHash: string;
  data: Buffer;
}

/** Encode a piece payload as a binary frame (filesync.md §3 table). */
export function encodeDataFrame(share: string, pieceHash: string, data: Buffer): Buffer {
  const shareBuf = Buffer.from(share, 'utf8');
  const out = Buffer.alloc(1 + HASH_LEN + SHARE_LEN_BYTES + shareBuf.length + data.length);
  let o = 0;
  out.writeUInt8(SYNC_DATA_TYPE, o); o += 1;
  Buffer.from(pieceHash, 'hex').copy(out, o); o += HASH_LEN;
  out.writeUInt16BE(shareBuf.length, o); o += SHARE_LEN_BYTES;
  shareBuf.copy(out, o); o += shareBuf.length;
  data.copy(out, o);
  return out;
}

/** Decode a binary frame; null when malformed / not ours. */
export function decodeDataFrame(buf: Buffer): SyncDataFrame | null {
  if (buf.length < 1 + HASH_LEN + SHARE_LEN_BYTES) return null;
  if (buf.readUInt8(0) !== SYNC_DATA_TYPE) return null;
  let o = 1;
  const pieceHash = buf.subarray(o, o + HASH_LEN).toString('hex'); o += HASH_LEN;
  const shareLen = buf.readUInt16BE(o); o += SHARE_LEN_BYTES;
  if (buf.length < o + shareLen) return null;
  const share = buf.subarray(o, o + shareLen).toString('utf8'); o += shareLen;
  return { t: 'data', share, pieceHash, data: buf.subarray(o) };
}

// ── Announce extension ─────────────────────────────────────────────────────

/** AnnounceFrame + membership gossip (filesync.md §3). */
export type AnnounceWithShares = AnnounceFrame & { shares?: string[] };
