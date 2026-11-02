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

export interface ManagerHooks extends EngineHooks {
  debugFilesync(): boolean;
  /** The host's work directory — mycc maps it to the package's explicit
   *  rootDir/stateDir (the package itself has no layout convention). */
  getWorkDir(): string;
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

let manager: FilesyncManager | null = null;

export function setFilesyncManager(m: FilesyncManager | null): void { manager = m; }
export function getFilesyncManager(): FilesyncManager | null { return manager; }

export class FilesyncManager {
  private readonly engines = new Map<string, FilesEngine>();
  private readonly hooks: ManagerHooks;
  private readonly port: PeerPort;

  constructor(hooks: ManagerHooks, port: PeerPort) {
    this.hooks = hooks;
    this.port = port;
  }

  /** Bound share ids (for announce.shares membership gossip). */
  shares(): string[] { return [...this.engines.keys()]; }

  has(share: string): boolean { return this.engines.has(share); }

  /** Bind a share: create `.mycc/filesync/<id>/`, start its engine. */
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
    return e;
  }

  unbind(share: string): boolean {
    const e = this.engines.get(share);
    if (!e) return false;
    e.close();
    this.engines.delete(share);
    return true;
  }

  get(share: string): FilesEngine | undefined { return this.engines.get(share); }

  closeAll(): void {
    for (const e of this.engines.values()) e.close();
    this.engines.clear();
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
    // Host-side adapter: wire frame → transport-agnostic engine message.
    // Every verb runs behind this one crash-guard.
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
  onPartnerShares(_peer: string, shares: string[]): void {
    for (const share of shares) {
      const e = this.engines.get(share);
      if (e) e.gossip();
    }
  }

  /** Share ids this instance binds — the membership challenge is computed
   *  from these, so nothing else can be claimed on our behalf. */
  localShares(): string[] { return this.shares(); }
}

/**
 * R5 (architect review): the manager IS the SyncDispatchTarget the wire-codec
 * dispatch helpers call into. The wire sites never touch manager method names
 * — they go through the injected WireHooks closures + wire-codec's
 * trySyncDispatch/trySyncDataDispatch/handlePeerShares.
 */
export type { SyncDispatchTarget };
