/**
 * Wire-format regression tests for the filesync adapter (src/peer/filesync).
 *
 * Pins the EXACT wire bytes an old instance must be able to parse. A double
 * fold (`messageToControl` returning `type:` and then `foldControl` running
 * again) silently rewrote every manifest into `sync-err` while leaving the
 * payload fields in place — a live two-daemon run was the only thing that
 * caught it. These assertions make it a unit failure instead.
 */
import { describe, it, expect } from 'vitest';
import { messageToControl, controlToMessage } from '../../peer/filesync/wire-codec.js';
import { foldControl } from '../../peer/filesync/wire-codec.js';
import type { SyncMessage } from '@pkubangbang/filesync-manager';

const wire = (msg: SyncMessage) => foldControl(messageToControl(msg));

describe('filesync wire adapter', () => {
  it('manifest folds to sync-index with entries/tombstones/conflicts (never files)', () => {
    const w = wire({ kind: 'manifest', share: 's1', files: [{ relPath: 'a.txt', gen: { mtimeMs: 1, sid: 'A' }, size: 1, pieceListHash: 'p' }], tombstones: [] });
    expect(w.type).toBe('sync-index');
    expect(Array.isArray(w.entries)).toBe(true);
    expect((w.entries as unknown[]).length).toBe(1);
    expect(w.tombstones).toEqual([]);
    expect(w.conflicts).toEqual([]);
    expect(w.files).toBeUndefined();
  });

  it('want-list folds to sync-req {file, want:pieces}', () => {
    const w = wire({ kind: 'want-list', share: 's1', relPath: 'a.txt' });
    expect(w).toMatchObject({ type: 'sync-req', share: 's1', file: 'a.txt', want: 'pieces' });
  });

  it('want-pieces folds to sync-req {pieceHashes}', () => {
    const w = wire({ kind: 'want-pieces', share: 's1', pieceHashes: ['h1'] });
    expect(w).toMatchObject({ type: 'sync-req', share: 's1', pieceHashes: ['h1'] });
  });

  it('piece-list folds to sync-pieces {file, pieceHashes}', () => {
    const w = wire({ kind: 'piece-list', share: 's1', relPath: 'a.txt', pieceHashes: ['h1'] });
    expect(w).toMatchObject({ type: 'sync-pieces', share: 's1', file: 'a.txt', pieceHashes: ['h1'] });
  });

  it('deletion folds to sync-del and error to sync-err', () => {
    expect(wire({ kind: 'deletion', share: 's1', relPath: 'a', gen: { mtimeMs: 5, sid: 'A' } }))
      .toMatchObject({ type: 'sync-del', relPath: 'a' });
    expect(wire({ kind: 'error', share: 's1', reason: 'r' }))
      .toMatchObject({ type: 'sync-err', reason: 'r' });
  });

  it('round-trips: a folded manifest unfolds back to the same engine message', () => {
    const msg: SyncMessage = {
      kind: 'manifest', share: 's1',
      files: [{ relPath: 'a.txt', gen: { mtimeMs: 7, sid: 'A' }, size: 3, pieceListHash: 'p' }],
      tombstones: [{ relPath: 'b.txt', gen: { mtimeMs: 9, sid: 'B' }, by: 'B' }],
    };
    const back = controlToMessage({ ...wire(msg), t: 'index' } as never);
    expect(back?.kind).toBe('manifest');
    expect((back as { files: unknown[] }).files.length).toBe(1);
    expect((back as { tombstones: unknown[] }).tombstones.length).toBe(1);
  });
});
