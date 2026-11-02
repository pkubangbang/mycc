/**
 * filesync unit tests — chunking, piece store integrity, index LWW/conflict,
 * frame codec, and the security fixes (R1 path traversal, G1 per-file
 * pending, G2 gen forgery, G9 piece-list pin). Filesystem-backed via a temp
 * dir; no network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chunkBuffer, pieceListHash, sha256Hex } from '../../peer/filesync/chunker.js';
import { PieceStore } from '../../peer/filesync/store.js';
import { ShareIndex, compareGen, conflictKey } from '../../peer/filesync/index.js';
import { encodeDataFrame, decodeDataFrame } from '../../peer/filesync/frames.js';
import { FilesEngine, type PeerPort, type EngineHooks } from '../../peer/filesync/engine.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesync-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function hooks(self = 'AAAA1111'): EngineHooks & { mail: Array<{ title: string }> } {
  const mail: Array<{ title: string }> = [];
  return {
    mail,
    appendLocalMail: (_f, title) => { mail.push({ title }); },
    verbose: () => {},
    getSelfSid: () => self,
    getWorkDir: () => tmp,
  };
}

class FakePort implements PeerPort {
  sent: Array<{ peer: string; frame?: unknown; data?: string }> = [];
  sendControl(peer: string, frame: unknown) { this.sent.push({ peer, frame }); return true; }
  sendData(peer: string, _s: string, pieceHash: string) { this.sent.push({ peer, data: pieceHash }); return true; }
  peers = new Set<string>();
  partners(_share: string) { return [...this.peers]; }
}

describe('chunker', () => {
  it('is deterministic and hashes verify', () => {
    const buf = Buffer.from('hello world '.repeat(5000));
    const a = chunkBuffer(buf);
    const b = chunkBuffer(buf);
    expect(a.map((p) => p.hash)).toEqual(b.map((p) => p.hash));
    for (const p of a) expect(sha256Hex(p.data)).toBe(p.hash);
    expect(pieceListHash(a)).toBe(pieceListHash(b));
    expect(Buffer.concat(a.map((p) => p.data)).equals(buf)).toBe(true);
  });
  it('reuses unchanged pieces after a small edit', () => {
    const base = Buffer.alloc(600_000, 7);
    const edited = Buffer.from(base); edited[300_000] = 9;
    const a = new Set(chunkBuffer(base).map((p) => p.hash));
    const b = chunkBuffer(edited);
    const overlap = b.filter((p) => a.has(p.hash)).length;
    expect(overlap).toBeGreaterThan(0);
  });
});

describe('PieceStore (R1 path traversal)', () => {
  it('rejects non-sha256 keys and traversal', () => {
    const store = new PieceStore(tmp, 'sh1');
    expect(() => store.get('/etc/passwd')).not.toThrow(); // returns null, not read
    expect(store.get('/etc/passwd')).toBeNull();
    expect(store.get('../../../etc/passwd')).toBeNull();
    expect(store.has('../escape')).toBe(false);
    expect(store.missing(['/etc/passwd', '../x'])).toEqual([]); // invalid dropped
  });
  it('stores and verifies pieces by content hash', () => {
    const store = new PieceStore(tmp, 'sh1');
    const data = Buffer.from('piece-data');
    const hash = sha256Hex(data);
    expect(store.put(hash, data)).toBe(true);
    expect(store.has(hash)).toBe(true);
    expect(store.get(hash)?.equals(data)).toBe(true);
    expect(store.put(hash, Buffer.from('tampered'))).toBe(false); // mismatch rejected
  });
});

describe('ShareIndex LWW + conflict', () => {
  it('compareGen: mtime then sid tiebreak', () => {
    expect(compareGen({ mtimeMs: 2, sid: 'a' }, { mtimeMs: 1, sid: 'b' })).toBeGreaterThan(0);
    expect(compareGen({ mtimeMs: 1, sid: 'b' }, { mtimeMs: 1, sid: 'a' })).toBeGreaterThan(0);
    expect(compareGen({ mtimeMs: 1, sid: 'a' }, { mtimeMs: 1, sid: 'a' })).toBe(0);
  });
  it('persists entries/tombstones/conflicts and expires resolved conflicts', () => {
    const idx = new ShareIndex(tmp, 'sh1');
    idx.set({ relPath: 'a.txt', gen: { mtimeMs: 1, sid: 'A' }, size: 1, pieceListHash: 'x', pieceHashes: ['h'] });
    idx.tombstone({ relPath: 'b.txt', gen: { mtimeMs: 2, sid: 'A' }, by: 'A' });
    const c = { relPath: 'a.txt', keptGen: { mtimeMs: 3, sid: 'B' }, loserSid: 'A', loserTs: 1 };
    idx.addConflict(c);
    expect(idx.conflicts.has(conflictKey(c))).toBe(true);
    // resolution = conflict copy gone → entry expires
    idx.expireResolved(() => false);
    expect(idx.conflicts.has(conflictKey(c))).toBe(false);
  });
});

describe('frame codec', () => {
  it('round-trips binary data frames', () => {
    const data = Buffer.from('raw piece bytes');
    const hash = sha256Hex(data);
    const buf = encodeDataFrame('abcdef01', hash, data);
    const dec = decodeDataFrame(buf);
    expect(dec?.share).toBe('abcdef01');
    expect(dec?.pieceHash).toBe(hash);
    expect(dec?.data.equals(data)).toBe(true);
  });
  it('rejects malformed binary frames', () => {
    expect(decodeDataFrame(Buffer.alloc(3))).toBeNull();
  });
});

describe('engine sync + security', () => {
  it('G1: multi-file index converges both files (no dropped fetch)', async () => {
    const h = hooks();
    const port = new FakePort();
    port.peers.add('BBBB2222');
    const e = new FilesEngine({ share: 'sh1', hooks: h, port });
    // Two files from partner, both newer than ours (we have none).
    e.onControlFrame('BBBB2222', {
      t: 'index', share: 'sh1',
      entries: [
        { relPath: 'one.txt', gen: { mtimeMs: Date.now(), sid: 'BBBB2222' }, size: 3, pieceListHash: sha256Hex(Buffer.from('abc')) },
        { relPath: 'two.txt', gen: { mtimeMs: Date.now(), sid: 'BBBB2222' }, size: 3, pieceListHash: sha256Hex(Buffer.from('def')) },
      ],
      tombstones: [], conflicts: [],
    });
    // Both files must be requested (pending per (peer,relPath) — G1).
    const reqs = port.sent.filter((s) => (s.frame as { t?: string })?.t === 'req');
    const files = reqs.map((s) => (s.frame as { file?: string }).file);
    expect(files).toContain('one.txt');
    expect(files).toContain('two.txt');
  });

  it('R1: a req for /etc/passwd serves nothing (no exfil)', () => {
    const h = hooks();
    const port = new FakePort();
    port.peers.add('BBBB2222');
    const e = new FilesEngine({ share: 'sh1', hooks: h, port });
    e.onControlFrame('BBBB2222', { t: 'req', share: 'sh1', pieceHashes: ['/etc/passwd', '../../secret'] });
    expect(port.sent.filter((s) => s.data)).toHaveLength(0);
  });

  it('G2: forged future-mtime tombstone is ignored', () => {
    const h = hooks();
    const port = new FakePort();
    port.peers.add('BBBB2222');
    const e = new FilesEngine({ share: 'sh1', hooks: h, port });
    const st = fs.statSync(e.root);
    void st;
    e.index.set({ relPath: 'keep.txt', gen: { mtimeMs: Date.now(), sid: 'AAAA1111' }, size: 1, pieceListHash: 'x', pieceHashes: ['h'] });
    e.onControlFrame('BBBB2222', { t: 'del', share: 'sh1', relPath: 'keep.txt', gen: { mtimeMs: 8.6e15, sid: 'BBBB2222' } });
    expect(e.index.get('keep.txt')).toBeDefined(); // not deleted
  });

  it('G9: a junk piece list cannot pin a fetch (hash mismatch drops it)', () => {
    const h = hooks();
    const port = new FakePort();
    port.peers.add('BBBB2222');
    const e = new FilesEngine({ share: 'sh1', hooks: h, port });
    const good = sha256Hex(Buffer.from('payload'));
    e.onControlFrame('BBBB2222', {
      t: 'index', share: 'sh1',
      entries: [{ relPath: 'f.bin', gen: { mtimeMs: Date.now(), sid: 'BBBB2222' }, size: 7, pieceListHash: sha256Hex(Buffer.from('payload')) }],
      tombstones: [], conflicts: [],
    });
    // Junk piece list (hashes don't match expected pieceListHash) → dropped.
    e.onPieceList('BBBB2222', 'f.bin', ['0'.repeat(64)]);
    const reqs = port.sent.filter((s) => (s.frame as { t?: string })?.t === 'req' && (s.frame as { pieceHashes?: string[] }).pieceHashes);
    // Should not request the junk hash.
    expect(reqs.every((s) => !(s.frame as { pieceHashes: string[] }).pieceHashes.includes('0'.repeat(64)))).toBe(true);
    void good;
  });
});
