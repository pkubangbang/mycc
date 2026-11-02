/**
 * filesync — shared folders synced across wire peers (docs/peers/filesync.md).
 *
 * Public surface of `src/peer/filesync/`. The wire plane (wire-registry /
 * wire-client / serve-peer-wire) and the `/share` slash consume this barrel.
 */

export { chunkBuffer, pieceListHash, sha256Hex, PIECE_MIN, PIECE_MAX, PIECE_AVG, type Piece } from './chunker.js';
export { PieceStore } from './store.js';
export {
  ShareIndex, compareGen, conflictKey,
  type FileEntry, type FileGen, type Tombstone, type ConflictEntry,
} from './index.js';
export {
  encodeDataFrame, decodeDataFrame, SYNC_DATA_TYPE,
  type SyncControlFrame, type SyncDataFrame, type SyncIndexFrame, type SyncReqFrame,
  type SyncDelFrame, type SyncErrFrame, type AnnounceWithShares,
} from './frames.js';
export { FrameAuditLog, type FrameLogLine } from './audit-log.js';
export {
  FilesEngine, GOSSIP_MS, WATCH_DEBOUNCE_MS, SKEW_DEADLINE_MS, REQUEST_WINDOW,
  type PeerPort, type EngineHooks, type EngineOptions,
} from './engine.js';
export {
  FilesyncManager, setFilesyncManager, getFilesyncManager,
  type ManagerHooks,
} from './manager.js';
