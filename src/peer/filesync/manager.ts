/**
 * manager.ts — the filesync share registry: bound shares + frame dispatch.
 *
 * The single entry point the wire plane calls (both acceptor
 * `serve/peer-wire.ts` and dialer `wire-client.ts` dispatch here), and the
 * surface `/share` and config bind through. One engine per bound share.
 *
 * Pairwise only — there is no relay and no routing (filesync.md §3): every
 * frame is sent to ONE partner over that partner's own wire. Multi-hop
 * delivery is emergent store-and-forward (a partner stores pieces as its
 * own folder content and serves them later).
 */

import path from 'path';
import {
  FilesEngine, type EngineHooks, type PeerPort,
} from '@pkubangbang/filesync-manager';
import {
  type SyncControlFrame, type SyncDataFrame,
} from './frames.js';
import { controlToMessage, dataToMessage, type SyncDispatchTarget } from './wire-codec.js';
import { announcedSharePeers, challengePeerShares } from '../wire-registry.js';

export interface ManagerHooks extends EngineHooks {
  debugFilesync(): boolean;
  /** The host's work directory — mycc maps it to the package's explicit
   *  rootDir/stateDir (the package itself has no layout convention). */
  getWorkDir(): string;
  /**
   * POPULATOR: make a bound share visible to the LLM.
   *
   * Syncing a folder the model never looks at is useless: `--share` created
   * `.mycc/filesync/<id>/` and synced it, but nothing told the agent the
   * folder existed, so a file that landed there stayed unread. This pins a
   * never-done todo naming the folder and how to use it (durable — pinned
   * todos survive auto-compact), and `unpinShareTodo` closes it on unbind.
   */
  pinShareTodo?(share: string, rootDir: string): void;
  unpinShareTodo?(share: string): void;
  /**
   * POPULATOR: tell the lead that files CHANGED in a share, e.g.
   * "[Note] you have new file in filesync share <id>; check
   * .mycc/filesync/<id>/". Batched per share (SHARE_NOTICE_DEBOUNCE_MS) so a
   * 50-file copy is one note, not 50.
   */
  notifyShareChange?(share: string, rootDir: string, changes: string[]): void;
}

/** mycc layout for a share (the ONLY place that knows it):
 *  contents  `<workDir>/.mycc/filesync/<share>/`
 *  state     `<workDir>/.mycc/filesync/.sync/<share>/`  (never synced) */
export function sharePaths(workDir: string, share: string): { rootDir: string; stateDir: string } {
  return {
    rootDir: path.join(workDir, '.mycc', 'filesync', share),
    stateDir: path.join(workDir, '.mycc', 'filesync', '.sync', share),
  };
}

/** One notice per burst: a directory copy or a recursive delete must not
 *  produce one mail per file. */
export const SHARE_NOTICE_DEBOUNCE_MS = 2_000;

let manager: FilesyncManager | null = null;

export function setFilesyncManager(m: FilesyncManager | null): void { manager = m; }
export function getFilesyncManager(): FilesyncManager | null { return manager; }

export class FilesyncManager {
  private readonly engines = new Map<string, FilesEngine>();
  private readonly hooks: ManagerHooks;
  private readonly port: PeerPort;
  /** share id → pending burst of change descriptions. */
  private readonly changeBatch = new Map<string, { timer: NodeJS.Timeout; changes: Set<string> }>();

  constructor(hooks: ManagerHooks, port: PeerPort) {
    this.hooks = hooks;
    this.port = port;
  }

  /** Bound share ids (for announce.shares membership gossip and the challenge
   *  the peer must answer before it becomes a partner). */
  shares(): string[] { return [...this.engines.keys()]; }

  has(share: string): boolean { return this.engines.has(share); }

  /** Bind a share: create `.mycc/filesync/<id>/`, start its engine, and make
   *  it visible to the LLM (pinned todo + the change-note channel). */
  bind(share: string): FilesEngine {
    let e = this.engines.get(share);
    if (e) return e;
    const { rootDir, stateDir } = sharePaths(this.hooks.getWorkDir(), share);
    e = new FilesEngine({
      share,
      rootDir,
      stateDir,
      hooks: this.hooks,
      port: this.port,
      debugFilesync: this.hooks.debugFilesync(),
    });
    this.engines.set(share, e);
    e.start();
    this.hooks.verbose('filesync', `bound share ${share} at ${e.root}`);
    try { this.hooks.pinShareTodo?.(share, e.root); } catch { /* best-effort */ }
    // LATE BIND (`/share <id>` after the wires are already up): membership is
    // discovered from a peer's ANNOUNCE, and an announce happened long ago —
    // so nothing would ever challenge for this new share and the engines would
    // idle forever until a reconnect. Re-challenge every peer that announced
    // shares: each answers with a proof for whatever it holds, and the ones
    // that hold THIS id become partners (`onPartnerShares` → gossip).
    try {
      let challenged = 0;
      for (const peer of announcedSharePeers()) {
        if (challengePeerShares(peer, this.localShares())) challenged++;
      }
      this.hooks.verbose('filesync', `late bind ${share}: re-challenged ${challenged} announced peer(s)`);
    } catch (err) { this.hooks.verbose('filesync', `late bind ${share}: reconciliation failed: ${String(err)}`); }
    return e;
  }

  unbind(share: string): boolean {
    const e = this.engines.get(share);
    if (!e) return false;
    e.close();
    this.engines.delete(share);
    const pending = this.changeBatch.get(share);
    if (pending) { clearTimeout(pending.timer); this.changeBatch.delete(share); }
    try { this.hooks.unpinShareTodo?.(share); } catch { /* best-effort */ }
    return true;
  }

  get(share: string): FilesEngine | undefined { return this.engines.get(share); }

  closeAll(): void {
    for (const e of this.engines.values()) e.close();
    this.engines.clear();
    for (const pending of this.changeBatch.values()) clearTimeout(pending.timer);
    this.changeBatch.clear();
  }

  /**
   * Report a synced change for a share. The lead gets one mail per burst
   * telling it where to look — this is the only sync traffic that reaches the
   * chat (filesync.md §4: no per-file arrival spam).
   */
  noteShareChange(share: string, relPath: string, verb: 'added' | 'updated' | 'deleted'): void {
    if (!this.hooks.notifyShareChange) return;
    const e = this.engines.get(share);
    if (!e) return;
    let batch = this.changeBatch.get(share);
    if (!batch) {
      const created = { changes: new Set<string>(), timer: null as unknown as NodeJS.Timeout };
      created.timer = setTimeout(() => {
        this.changeBatch.delete(share);
        try { this.hooks.notifyShareChange?.(share, e.root, [...created.changes]); } catch { /* best-effort */ }
      }, SHARE_NOTICE_DEBOUNCE_MS);
      created.timer.unref?.();
      batch = created;
      this.changeBatch.set(share, batch);
    }
    batch.changes.add(`${verb} ${relPath}`);
  }

  // ── Frame dispatch (called by the wire plane on inbound frames) ─────────

  onControlFrame(peer: string, frame: SyncControlFrame): void {
    if (typeof frame.share !== 'string' || frame.share.length === 0) return;
    const share: string = frame.share;
    const e = this.engines.get(share);
    if (!e) return; // not our share — drop (membership = possession)
    // R1 (architect review): the engine's switch owns ALL 5 verbs, so every
    // handler — including onPieceList — runs behind this one crash-guard.
    // (A pre-branch here used to reach onPieceList OUTSIDE the guard: a
    // hostile sync-pieces frame could throw and kill the process.)
    try {
      const msg = controlToMessage(frame);
      if (msg) e.onMessage(peer, msg);
    } catch (err) { this.hooks.verbose('filesync', `dropped frame from ${peer}: ${String(err)}`); }
  }

  onDataFrame(peer: string, frame: SyncDataFrame): void {
    const e = this.engines.get(frame.share);
    if (!e) return;
    try { e.onData(peer, dataToMessage(frame)); }
    catch (err) { this.hooks.verbose('filesync', `dropped data from ${peer}: ${String(err)}`); }
  }

  /** A partner PROVED membership of these share ids — membership gossip
   *  drives an immediate index exchange (join latency) with every partner
   *  carrying a bound share. Ids are LOCAL ids (the wire carries nonces, and
   *  the codec translates them); an id we do not bind is ignored. */
  onPartnerShares(peer: string, shares: string[]): void {
    // Handshake outcome is the first thing a live convergence failure has to
    // settle: a proof that never confirmed means no partner, so no manifest
    // ever goes out and the frames log shows inbound traffic only.
    // A RE-prove (a share bound after the wires came up) also lands here: only
    // report peers this call newly confirmed, or every late bind would claim
    // a new partner it already had. `confirmShareChallenges` returns the
    // proven set for THIS challenge, so that is exactly the new evidence.
    this.hooks.verbose('filesync', `peer ${peer} proved shares: ${shares.join(', ') || '(none)'}`);
    for (const share of shares) {
      const e = this.engines.get(share);
      if (!e) {
        this.hooks.verbose('filesync', `peer ${peer} proved unbound share ${share} — ignored`);
        continue;
      }
      this.hooks.verbose('filesync', `gossip to new partner ${peer} for share ${share}`);
      e.gossip();
    }
  }

  /** Share ids this instance binds — the membership challenge is computed
   *  from these, so nothing else can be claimed on our behalf. */
  localShares(): string[] { return this.shares(); }

  /** Engine → host bridge: a partner's file landed (or was removed) in a
   *  share. Batched by the host into one "[Note] … check the folder" mail. */
  noteFileChange(share: string, relPath: string, origin: 'local' | 'remote', change: 'added' | 'updated' | 'deleted'): void {
    if (origin !== 'remote') return; // our own edits need no note
    this.noteShareChange(share, relPath, change);
  }
}

/**
 * R5 (architect review): the manager IS the SyncDispatchTarget the wire-codec
 * dispatch helpers call into. The wire sites never touch manager method names
 * — they go through the injected WireHooks closures + wire-codec's
 * trySyncDispatch/trySyncDataDispatch/handlePeerShares.
 */
export type { SyncDispatchTarget };
