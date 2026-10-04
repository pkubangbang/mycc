/**
 * peers-state.ts — reconcile a peer record with the live identity store:
 * matching (§6.2), the identity repair pass (§6.4), and the status row.
 *
 * Everything here reads or writes identity.json. Nothing here spawns a
 * process; the launch/stop side lives in peers-lifecycle.ts.
 */

import { argsMatch } from '../../../src/utils/arg-canonical.js';
import {
  readIdentityMap,
  writeIdentityMap,
  readHeartbeatData,
  isPeerRunning,
  isPidAlive,
  lastBrief,
  FRESHNESS_WINDOW_MS,
  IDENTITY_FILE,
} from './discovery.js';
import type { IdentityEntry } from './discovery.js';
import path from 'path';
import { withFileLock } from '../../../src/utils/file-lock.js';
import { peerIdentityArgs, peerMailboxPath } from './peers-types.js';
import type { Peer, PeerStatusRow } from './peers-types.js';

// ---------------------------------------------------------------------------
// Matching (§6.2)
// ---------------------------------------------------------------------------

/** Compare two workdirs, tolerant of separators and trailing slash. */
export function sameWorkdir(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Find the best live identity entry matching a peer record: same sessionId,
 * same workdir, and canonical args equal (via argsMatch, *** as wildcard).
 * Returns the entry or null.
 */
export function findMatchingLiveEntry(peer: Peer): IdentityEntry | null {
  if (!peer.sessionId || !isPeerRunning(peer)) return null;
  const map = readIdentityMap();
  const entry = map[peer.sessionId];
  if (!entry) return null;
  if (!sameWorkdir(entry.workDir ?? entry.workdir, peer.workdir)) return null;
  // Old instances may lack `args`; argsMatch treats missing as '(none)'.
  if (!argsMatch(entry.args ?? '(none)', peer.args)) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Identity repair pass (§6.4)
// ---------------------------------------------------------------------------

/**
 * For each peer with a FRESH heartbeat, a LIVE recorded pid and NO identity
 * entry, read-merge-write the entry back into identity.json (register() loses
 * races under concurrency). Returns the number of entries repaired.
 *
 * Two defects the naive single read-merge-write had:
 *   - it clobbered a concurrent register(): the map it read was stale by the
 *     time its rename landed, silently dropping another instance's entry —
 *     including the entry the `--session-id` held-guard depends on, which is
 *     what let two `sync` runs split-brain. Fixed with the same retry +
 *     re-read/verify loop register() uses: every iteration re-reads, merges the
 *     missing entries on top, writes, and re-verifies.
 *   - it resurrected identity entries for peers that had cleanly unregistered
 *     (`peer.stop()` → `unregister()`), because it gated on heartbeat freshness
 *     alone. A dead peer's heartbeat file lingers for up to 90s; gating on the
 *     recorded pid being ALIVE avoids minting a ghost entry.
 *
 * RACE SAFETY: the read→write lost-update race is closed by holding the shared
 * cross-process identity.json lock (withFileLock) across the whole read-merge-
 * write section — the SAME lock IdentityManager.register()/unregister() take,
 * so repair and registration can never interleave. The per-iteration re-read +
 * verify loop is kept as defense-in-depth (and to converge against a
 * hypothetical writer that did not take the lock).
 */
export function repairIdentity(peers: Peer[]): number {
  const pending = new Map<string, IdentityEntry>(); // sessionId → entry to (re)insert
  // Read the identity map ONCE up front so we only enqueue peers whose sid is
  // GENUINELY ABSENT — repairIdentity's purpose is to backfill entries
  // register() lost under concurrency, NOT to rewrite live entries. A present
  // entry must NEVER be overwritten: re-running `up` on already-live,
  // already-registered peers must be a no-op (else every `up` clobbers
  // startedAt/args/mailbox and `up` is non-idempotent — BUG #2).
  const presentMap = readIdentityMap();
  for (const peer of peers) {
    if (!peer.sessionId) continue;
    if (peer.sessionId in presentMap) continue; // already registered → leave it alone
    const { heartbeats, pid } = readHeartbeatData(peer.sessionId);
    if (heartbeats.length === 0) continue;
    const fresh = Date.now() - heartbeats[heartbeats.length - 1] <= FRESHNESS_WINDOW_MS;
    if (!fresh) continue;
    // A fresh beat with no live pid is either a legacy writer (cannot repair
    // faithfully) or a peer that already exited → do not resurrect it.
    if (typeof pid !== 'number' || !isPidAlive(pid)) continue;

    // Reconstitute a minimal, correct entry (see peerMailboxPath for why the
    // mailbox resolves against the peer's workdir and never os.homedir()).
    pending.set(peer.sessionId, {
      sessionId: peer.sessionId,
      workDir: peer.workdir as string,
      mailbox: peerMailboxPath(peer),
      startedAt: heartbeats[0],
      args: peerIdentityArgs(peer),
      pid,
    });
  }
  if (pending.size === 0) return 0;

  let repaired = 0;
  // Hold the shared identity.json lock for the entire read→write→verify
  // section, so no concurrent register()/unregister()/repair can interleave a
  // read-merge-write and lose an entry. The per-iteration re-read below is
  // retained as defense-in-depth (and to converge if a non-locking writer ever
  // lands), but the lock is what actually closes the lost-update window.
  withFileLock(IDENTITY_FILE, () => {
    for (let attempt = 0; attempt < 5 && pending.size > 0; attempt++) {
      // Re-read EVERY iteration so a registration that landed since the last
      // write is preserved (we merge on top of it, never clobber it).
      const map = readIdentityMap();
      for (const [sid, entry] of pending) {
        if (!(sid in map)) map[sid] = entry;
      }

      // Re-read again immediately before the write and merge whatever landed
      // since the first read. Under the lock this is belt-and-suspenders; it
      // still protects against a writer that did not take the lock.
      const latest = readIdentityMap();
      for (const [sid, entry] of Object.entries(latest)) {
        if (!(sid in map)) map[sid] = entry;
      }
      // Our own pending entries only land for sids that were ABSENT at build
      // time; guard the write anyway so a concurrent register() that inserted
      // one of them in the gap is preserved, not clobbered ("insert if absent").
      for (const [sid, entry] of pending) {
        if (!(sid in map)) map[sid] = entry;
      }

      writeIdentityMap(map);

      // Verify: entries present after the rename are done (count them once).
      const after = readIdentityMap();
      for (const sid of [...pending.keys()]) {
        if (sid in after) {
          pending.delete(sid);
          repaired++;
        }
      }
    }
  });
  return repaired;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Per-peer status row: {name, sessionId, live, matching, lastBrief}. */
export function peerStatus(peer: Peer): PeerStatusRow {
  return {
    name: peer.name as string,
    sessionId: peer.sessionId ?? null,
    // "live" reflects an actually-running process (fresh heartbeat AND alive
    // pid), not merely a not-yet-expired heartbeat file.
    live: isPeerRunning(peer),
    matching: findMatchingLiveEntry(peer) !== null,
    lastBrief: lastBrief(peer.sessionId as string),
  };
}
