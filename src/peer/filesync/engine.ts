/**
 * engine.ts — the filesync engine: one per bound share (filesync.md).
 *
 * Responsibilities (all transport-independent — the wire layer calls in via
 * `onControlFrame`/`onDataFrame` and out via the injected `PeerPort`):
 *   - scan: walk the share root, chunk changed files, update the index
 *   - gossip: emit/receive `sync-index` (join, change, every GOSSIP_MS)
 *   - fetch: request missing pieces (window K), apply complete files
 *   - watch: debounce local fs events into a scan (latency, not correctness)
 *   - conflict: LWW with loser preservation + conflict-log + lead mail
 *
 * Security hardening (joint red/blue review): R1 hash-shape validation (in
 * store.ts), G1 per-(peer,file) pending, G2 gen/sid forgery guards, R2 safe
 * date/filename handling, G3 input caps, R3 one-gossip-per-index, G4
 * conflict-mail rate limit, G5 resolve+O_NOFOLLOW at apply.
 */

import fs from 'fs';
import path from 'path';
import { chunkBuffer, pieceListHash, type Piece } from './chunker.js';
import { PieceStore } from './store.js';
import {
  ShareIndex, compareGen, conflictKey,
  type ConflictEntry, type FileEntry, type FileGen,
} from './index.js';
import {
  type SyncControlFrame, type SyncDataFrame,
} from './frames.js';
import { FrameAuditLog } from './audit-log.js';

export const GOSSIP_MS = 30_000;
export const WATCH_DEBOUNCE_MS = 300;
export const SKEW_DEADLINE_MS = 10_000;
export const REQUEST_WINDOW = 8;

const MAX_INDEX_ENTRIES = 10_000;   // G3
const MAX_PIECE_LIST = 20_000;      // G3
const MAX_REQ_BATCH = 32;           // G3 (2× REQUEST_WINDOW)
const GEN_MAX_SKEW_MS = 24 * 60 * 60 * 1000; // G2
const CONFLICT_MAIL_WINDOW_MS = 60_000;      // G4

/** Wire-facing sink — implemented by the wire plane (registry socket
 *  lookup); fakeable in tests. `peer` is the partner's session id. */
export interface PeerPort {
  sendControl(peer: string, frame: SyncControlFrame): boolean;
  sendData(peer: string, share: string, pieceHash: string, data: Buffer): boolean;
  partners(share: string): string[];
}

/** Engine → lead surface (conflict mail + pinned share todo). */
export interface EngineHooks {
  appendLocalMail(from: string, title: string, content: string): void;
  verbose(tool: string, message: string): void;
  getSelfSid(): string;
  getWorkDir(): string;
}

export interface EngineOptions {
  share: string;
  hooks: EngineHooks;
  port: PeerPort;
  debugFilesync?: boolean;
  maxFileBytes?: number;
}

interface PendingFile {
  entry: FileEntry;
  missing: string[];
  requested: Map<string, number>;
  awaitingPieceList?: boolean;
}

/** G1 fix: pending is keyed per (peer, relPath) — one PendingFile PER FILE,
 *  so a multi-file index frame never overwrites/drops another file's fetch
 *  (which made the file vanish → scan() tombstone → swarm-wide del). */
function pendingKey(peer: string, relPath: string): string {
  return `${peer}\u0000${relPath}`;
}

/** Safe ISO timestamp for filenames/logs — never throws (R2). */
function safeIso(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15) return 'invalid';
  return new Date(ms).toISOString();
}

/** Sanitize a sid for use in a filename (R2). */
function safeSidTag(sid: string): string {
  return String(sid).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'x';
}

export class FilesEngine {
  readonly share: string;
  readonly root: string;
  readonly store: PieceStore;
  readonly index: ShareIndex;
  readonly audit: FrameAuditLog;
  private readonly hooks: EngineHooks;
  private readonly port: PeerPort;
  private readonly maxFileBytes: number;
  private readonly pending = new Map<string, PendingFile>();
  private readonly partnerIndexes = new Map<string, Map<string, FileEntry>>();
  private readonly seenConflicts = new Set<string>();
  private readonly conflictMailAt = new Map<string, number>();
  private watchTimer: NodeJS.Timeout | null = null;
  private gossipTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private closed = false;

  constructor(opts: EngineOptions) {
    this.share = opts.share;
    this.hooks = opts.hooks;
    this.port = opts.port;
    this.maxFileBytes = opts.maxFileBytes ?? 500 * 1024 * 1024;
    this.root = path.join(opts.hooks.getWorkDir(), '.mycc', 'filesync', opts.share);
    fs.mkdirSync(this.root, { recursive: true });
    this.store = new PieceStore(opts.hooks.getWorkDir(), opts.share);
    this.index = new ShareIndex(opts.hooks.getWorkDir(), opts.share);
    this.audit = new FrameAuditLog(opts.hooks.getWorkDir(), opts.share, opts.debugFilesync ?? false);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    this.scan();
    this.gossip();
    this.gossipTimer = setInterval(() => this.gossip(), GOSSIP_MS);
    this.gossipTimer.unref?.();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, () => this.scheduleScan());
    } catch {
      this.hooks.verbose('filesync', `watch unavailable for ${this.share}; relying on gossip (${GOSSIP_MS}ms)`);
    }
  }

  close(): void {
    this.closed = true;
    if (this.gossipTimer) clearInterval(this.gossipTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    try { this.watcher?.close(); } catch { /* closing */ }
    this.audit.close();
    this.index.persist();
  }

  private scheduleScan(): void {
    if (this.closed) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => { this.scan(); this.gossip(); }, WATCH_DEBOUNCE_MS);
  }

  // ── Scan: local truth → index ────────────────────────────────────────────

  scan(): void {
    const seen = new Set<string>();
    for (const relPath of this.walk(this.root)) {
      seen.add(relPath);
      this.ingest(relPath);
    }
    for (const relPath of [...this.index.entries.keys()]) {
      if (seen.has(relPath)) continue;
      const entry = this.index.entries.get(relPath)!;
      this.index.tombstone({ relPath, gen: { mtimeMs: Date.now(), sid: this.hooks.getSelfSid() }, by: this.hooks.getSelfSid() });
      this.broadcast({ t: 'del', share: this.share, relPath, gen: { mtimeMs: entry.gen.mtimeMs + 1, sid: this.hooks.getSelfSid() } });
      void entry;
    }
    this.index.expireResolved((c) => fs.existsSync(this.conflictPath(c)));
  }

  private walk(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (name === '.sync') continue;
      const abs = path.join(dir, name);
      const relPath = prefix ? `${prefix}/${name}` : name;
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) { this.hooks.verbose('filesync', `skipping symlink ${relPath}`); continue; }
      if (st.isDirectory()) { out.push(...this.walk(abs, relPath)); continue; }
      if (!st.isFile()) continue;
      if (name.includes('.conflict-')) continue;
      out.push(relPath);
    }
    return out;
  }

  private ingest(relPath: string): void {
    const abs = this.resolve(relPath);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.size > this.maxFileBytes) {
      this.hooks.verbose('filesync', `skipping oversize ${relPath} (${st.size} bytes)`);
      return;
    }
    const prev = this.index.get(relPath);
    // G8 fix: an mtime pre-filter (not size) so same-size edits re-sync.
    if (prev && prev.gen.mtimeMs === st.mtimeMs && prev.size === st.size) return;
    let data: Buffer;
    try { data = fs.readFileSync(abs); } catch { return; }
    const pieces = chunkBuffer(data);
    for (const p of pieces) this.store.put(p.hash, p.data);
    const plh = pieceListHash(pieces);
    if (prev && prev.pieceListHash === plh) return;
    this.index.set({
      relPath,
      gen: { mtimeMs: st.mtimeMs, sid: this.hooks.getSelfSid() },
      size: st.size,
      pieceListHash: plh,
      pieceHashes: pieces.map((p) => p.hash),
    });
  }

  // ── Gossip ───────────────────────────────────────────────────────────────

  gossip(): void {
    const frame: SyncControlFrame = {
      t: 'index',
      share: this.share,
      entries: [...this.index.entries.values()].map((e) => ({
        relPath: e.relPath, gen: e.gen, size: e.size, pieceListHash: e.pieceListHash,
      })),
      tombstones: [...this.index.tombstones.values()],
      conflicts: [...this.index.conflicts.values()],
    };
    for (const peer of this.port.partners(this.share)) this.sendControl(peer, frame);
  }

  private broadcast(frame: SyncControlFrame): void {
    for (const peer of this.port.partners(this.share)) this.sendControl(peer, frame);
  }

  private sendControl(peer: string, frame: SyncControlFrame): void {
    this.audit.log('tx', peer, `sync-${frame.t}`, this.share, frame.t === 'index'
      ? { entries: frame.entries.length, tombstones: frame.tombstones.length, conflicts: frame.conflicts.length }
      : frame as unknown as Record<string, unknown>);
    this.port.sendControl(peer, frame);
  }

  /** R2 (architect review): symmetric to sendControl — one audit layer for
   *  both directions of tx (control + data) instead of an ad-hoc log at the
   *  call site. */
  private sendData(peer: string, pieceHash: string, data: Buffer): void {
    this.audit.log('tx', peer, 'sync-data', this.share, { piece: pieceHash, bytes: data.length });
    this.port.sendData(peer, this.share, pieceHash, data);
  }

  // ── Inbound (wire dispatch) ──────────────────────────────────────────────

  onControlFrame(peer: string, frame: SyncControlFrame): void {
    this.audit.log('rx', peer, `sync-${frame.t}`, this.share, frame as unknown as Record<string, unknown>);
    switch (frame.t) {
      case 'index': return this.onIndex(peer, frame);
      case 'req': return this.onReq(peer, frame);
      case 'pieces': return this.onPieceList(peer, frame.file, frame.pieceHashes);
      case 'del': return this.onDel(peer, frame);
      case 'err': return this.hooks.verbose('filesync', `peer ${peer} error: ${frame.reason}`);
    }
  }

  onDataFrame(peer: string, frame: SyncDataFrame): void {
    this.audit.log('rx', peer, 'sync-data', this.share, { piece: frame.pieceHash, bytes: frame.data.length });
    if (frame.share !== this.share) return;
    if (!/^[0-9a-f]{64}$/.test(frame.pieceHash)) return; // R1
    // Unsolicited pieces are dropped (filesync.md §3) — request-set only.
    for (const [key, p] of this.pending) {
      if (!key.startsWith(`${peer}\u0000`)) continue;
      if (!p.requested.has(frame.pieceHash)) continue;
      if (!this.store.put(frame.pieceHash, frame.data)) {
        this.hooks.verbose('filesync', `piece hash mismatch from ${peer}: ${frame.pieceHash}`);
        return;
      }
      p.requested.delete(frame.pieceHash);
      p.missing = p.missing.filter((h) => h !== frame.pieceHash);
      this.pump(peer, p.entry.relPath);
      this.maybeApply(peer, p.entry.relPath, p);
      return;
    }
  }

  /** G2 fix: reject forged future gens and normalize sid to the transport's
   *  peer (never trust the frame's own sid claim). */
  private sanitizeGen(gen: FileGen | undefined, peer: string): FileGen | null {
    if (!gen || !Number.isFinite(gen.mtimeMs) || gen.mtimeMs < 0) return null;
    if (gen.mtimeMs > Date.now() + GEN_MAX_SKEW_MS) return null;
    return { mtimeMs: gen.mtimeMs, sid: peer };
  }

  private onIndex(peer: string, frame: Extract<SyncControlFrame, { t: 'index' }>): void {
    if (frame.share !== this.share) return;
    const remote = new Map<string, FileEntry>();
    let count = 0;
    for (const e of frame.entries) {
      if (count++ >= MAX_INDEX_ENTRIES) break; // G3
      const gen = this.sanitizeGen(e.gen, peer);
      if (!gen) continue;
      remote.set(e.relPath, { relPath: e.relPath, gen, size: e.size, pieceListHash: e.pieceListHash, pieceHashes: [] });
    }
    this.partnerIndexes.set(peer, remote);

    for (const c of frame.conflicts) this.ingestConflictNotice(peer, c);

    let needGossip = false; // R3: at most ONE gossip per index frame
    for (const [relPath, re] of remote) {
      const mine = this.index.get(relPath);
      if (mine && mine.pieceListHash === re.pieceListHash) continue;
      if (mine && compareGen(re.gen, mine.gen) <= 0) continue;
      // Storm guard (R3): skip files already being fetched from this peer.
      // Without this, every echo'd index re-triggers requestFile → an
      // unbounded want:"pieces" loop (the 60k-frame flood the smoke caught).
      if (this.pending.has(pendingKey(peer, relPath))) continue;
      if (mine) this.preserveLoser(relPath, mine, re.gen);
      this.requestFile(peer, relPath, re);
    }
    for (const t of frame.tombstones) {
      const gen = this.sanitizeGen(t.gen, peer);
      if (!gen) continue;
      const mine = this.index.get(t.relPath);
      if (!mine) continue;
      if (compareGen(gen, mine.gen) <= 0) { needGossip = true; continue; }
      this.index.tombstone({ relPath: t.relPath, gen, by: peer });
    }
    if (needGossip) this.gossip();
  }

  private onDel(peer: string, frame: Extract<SyncControlFrame, { t: 'del' }>): void {
    if (frame.share !== this.share) return;
    const gen = this.sanitizeGen(frame.gen, peer);
    if (!gen) return;
    const mine = this.index.get(frame.relPath);
    if (mine && compareGen(gen, mine.gen) <= 0) { this.gossip(); return; }
    this.index.tombstone({ relPath: frame.relPath, gen, by: peer });
  }

  private onReq(peer: string, frame: Extract<SyncControlFrame, { t: 'req' }>): void {
    if (frame.share !== this.share) return;
    if (frame.want === 'pieces' && frame.file) {
      const mine = this.index.get(frame.file);
      if (!mine) return;
      this.sendControl(peer, { t: 'index', share: this.share, entries: [{ relPath: mine.relPath, gen: mine.gen, size: mine.size, pieceListHash: mine.pieceListHash }], tombstones: [], conflicts: [] });
      this.sendControl(peer, { t: 'pieces', share: this.share, file: mine.relPath, pieceHashes: mine.pieceHashes });
      return;
    }
    const hashes = (frame.pieceHashes ?? []).slice(0, MAX_REQ_BATCH); // G3
    for (const h of hashes) {
      if (!/^[0-9a-f]{64}$/.test(h)) continue; // R1
      const data = this.store.get(h);
      if (!data) continue;
      this.sendData(peer, h, data);
    }
  }

  // ── Fetch & apply ────────────────────────────────────────────────────────

  private requestFile(peer: string, relPath: string, re: FileEntry): void {
    const key = pendingKey(peer, relPath);
    let p = this.pending.get(key);
    if (!p) { p = { entry: re, missing: [], requested: new Map() }; this.pending.set(key, p); }
    p.entry = re;
    p.awaitingPieceList = true;
    this.sendControl(peer, { t: 'req', share: this.share, file: relPath, want: 'pieces' });
  }

  onPieceList(peer: string, relPath: string, hashes: string[]): void {
    const key = pendingKey(peer, relPath);
    const p = this.pending.get(key);
    if (!p || p.entry.relPath !== relPath) return;
    if (hashes.length > MAX_PIECE_LIST) return; // G3
    // G9 fix: verify the supplied piece list hashes to the expected
    // pieceListHash before pumping — a junk list can no longer pin us.
    const clean = hashes.filter((h) => /^[0-9a-f]{64}$/.test(h)); // R1
    if (pieceListHash(clean.map((h) => ({ hash: h }))) !== p.entry.pieceListHash) {
      this.hooks.verbose('filesync', `piece list hash mismatch for ${relPath} from ${peer}`);
      this.pending.delete(key);
      return;
    }
    p.entry = { ...p.entry, pieceHashes: clean };
    p.awaitingPieceList = false;
    p.missing = this.store.missing(clean);
    this.pump(peer, relPath);
    this.maybeApply(peer, relPath, p);
  }

  private pump(peer: string, relPath: string): void {
    const p = this.pending.get(pendingKey(peer, relPath));
    if (!p) return;
    const now = Date.now();
    for (const [h, deadline] of p.requested) {
      if (deadline <= now) p.requested.delete(h);
    }
    const want: string[] = [];
    for (const h of p.missing) {
      if (p.requested.has(h)) continue;
      if (p.requested.size + want.length >= REQUEST_WINDOW) break;
      want.push(h);
    }
    if (!want.length) return;
    for (const h of want) p.requested.set(h, now + SKEW_DEADLINE_MS);
    this.sendControl(peer, { t: 'req', share: this.share, pieceHashes: want });
  }

  private maybeApply(peer: string, relPath: string, p: PendingFile): void {
    if (p.awaitingPieceList || p.missing.length) return;
    const { entry } = p;
    const key = pendingKey(peer, relPath);
    const parts: Piece[] = [];
    for (const h of entry.pieceHashes) {
      const data = this.store.get(h);
      if (!data) return;
      parts.push({ hash: h, data });
    }
    const out = Buffer.concat(parts.map((x) => x.data));
    if (pieceListHash(parts) !== entry.pieceListHash || out.length !== entry.size) {
      this.hooks.verbose('filesync', `assemble verify failed for ${entry.relPath} from ${peer}`);
      this.pending.delete(key);
      return;
    }
    let abs: string;
    try { abs = this.resolve(entry.relPath); } catch { this.pending.delete(key); return; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // G5: O_NOFOLLOW|O_EXCL tmp write — a pre-planted symlink at the tmp
    // name can no longer clobber a file outside the root.
    const tmp = `${abs}.filesync-tmp`;
    try {
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeSync(fd, out);
      fs.closeSync(fd);
      fs.renameSync(tmp, abs);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      this.hooks.verbose('filesync', `apply failed for ${entry.relPath}: ${String(err)}`);
      this.pending.delete(key);
      return;
    }
    try { fs.utimesSync(abs, new Date(entry.gen.mtimeMs), new Date(entry.gen.mtimeMs)); } catch { /* best effort */ }
    this.index.set({ ...entry });
    this.pending.delete(key);
    this.gossip();
  }

  // ── Conflict handling (filesync.md §4) ───────────────────────────────────

  private preserveLoser(relPath: string, mine: FileEntry, theirs: FileGen): void {
    let abs: string;
    try { abs = this.resolve(relPath); } catch { return; }
    const c: ConflictEntry = {
      relPath,
      keptGen: theirs,
      loserSid: mine.gen.sid,
      loserTs: mine.gen.mtimeMs,
    };
    const copy = this.conflictPath(c);
    try { fs.renameSync(abs, copy); } catch { try { fs.copyFileSync(abs, copy); } catch { /* best effort */ } }
    this.index.addConflict(c);
  }

  private conflictPath(c: ConflictEntry): string {
    const d = path.dirname(c.relPath);
    const base = path.basename(c.relPath);
    const ts = safeIso(c.loserTs).replace(/[:.]/g, '-'); // R2
    const name = `${base}.conflict-${safeSidTag(c.loserSid)}-${ts}`; // R2
    return this.resolve(d === '.' ? name : `${d}/${name}`);
  }

  private ingestConflictNotice(_peer: string, c: ConflictEntry): void {
    const key = conflictKey(c);
    if (this.seenConflicts.has(key)) return;
    this.seenConflicts.add(key);
    // G4: rate-limit conflict mail per relPath (a varying loserTs can no
    // longer flood the lead's mailbox).
    const now = Date.now();
    const last = this.conflictMailAt.get(c.relPath) ?? 0;
    if (now - last < CONFLICT_MAIL_WINDOW_MS) return;
    this.conflictMailAt.set(c.relPath, now);

    if (!this.index.conflicts.has(key)) this.index.addConflict(c);
    const mineSid = this.hooks.getSelfSid();
    const yoursKept = c.loserSid !== mineSid;
    const title = `[sync-conflict] ${c.relPath} (share ${this.share})`;
    const content = yoursKept
      ? `local (you, ${safeIso(c.loserTs)}) vs ${c.keptGen.sid}/lead (${safeIso(c.keptGen.mtimeMs)}) — theirs kept (LWW); your version preserved as ${this.conflictPath(c)}.\nResolve in chat: compare the two files, then rm the conflict copy (accept theirs) or edit/overwrite the kept file (merge/keep yours) — the resolution is a normal file change and syncs like any other.`
      : `yours kept (LWW, ${safeIso(c.keptGen.mtimeMs)}); ${c.loserSid}/lead's version (${safeIso(c.loserTs)}) preserved on their side as a conflict copy.\nNo action needed unless you want to merge — their edit is not lost.`;
    this.hooks.appendLocalMail('filesync', title, content);
  }

  // ── Paths (confinement: belt + suspenders, filesync.md §5) ───────────────

  private resolve(relPath: string): string {
    const abs = path.resolve(this.root, relPath);
    const rootResolved = path.resolve(this.root);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      throw new Error(`filesync: relPath escapes share root: ${relPath}`);
    }
    return abs;
  }
}
