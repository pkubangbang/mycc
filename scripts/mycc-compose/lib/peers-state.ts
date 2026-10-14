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
  peerPid,
  resolveLivePeer,
  lastBrief,
  FRESHNESS_WINDOW_MS,
  IDENTITY_FILE,
} from './discovery.js';
import type { IdentityEntry } from './discovery.js';
import path from 'path';
import { withFileLock, FileLockTimeoutError } from '../../../src/utils/file-lock.js';
import { peerIdentityArgs, peerMailboxPath, sleep } from './peers-types.js';
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
 * Resolve a peer to the session id of its LIVE instance, via the durable NAME
 * scanned against identity.json (see resolveLivePeer), and STAMP the result
 * onto `peer.sessionId` so the runtime consumers (stopPeer's heartbeat keying,
 * peerMailboxPath, the beat-poll) read a concrete sid.
 *
 * WHY STAMP: the peer record is the single carried handle through cmd-up →
 * lifecycle; the resolved sid must reach stopPeer/launchPeer, which key their
 * liveness/kill evidence on `peer.sessionId`. Stamping keeps them unchanged
 * (they still read a sid) while making the SOURCE of that sid name-resolution
 * rather than a spec-authored/minted value.
 *
 * Returns the resolved sid, or null when no live instance matches. A peer that
 * already carries a runtime sid (the S0-bridge mint, Slice 3) keeps it when
 * name resolution finds nothing — see callers: minting is still the fallback
 * until Slice 3 removes it.
 */
export function resolvePeerSid(peer: Peer): string | null {
  const sid = resolveLivePeer(peer);
  if (sid) peer.sessionId = sid;
  return sid;
}

/**
 * Find the best live identity entry matching a peer record: the peer's LIVE
 * instance (resolved by durable NAME + workdir via {@link resolvePeerSid}),
 * requiring workdir match and canonical args equal (via argsMatch, *** as
 * wildcard). Returns the entry or null.
 *
 * The NAME is the match key (stable across the per-run sid churn); the
 * resolved sid merely LOCATES the entry. Two groups may share a leaf name, so
 * workdir + args still gate the match.
 */
export function findMatchingLiveEntry(peer: Peer): IdentityEntry | null {
  const sid = resolvePeerSid(peer);
  if (!sid) return null;
  const map = readIdentityMap();
  const entry = map[sid];
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
      // Publish the durable NAME so a backfilled entry is resolvable by name —
      // without it the next `up` could not re-find this peer (resolveLivePeer
      // scans by name), turning every repair into a phantom it must re-mint.
      ...((peer.identityName ?? peer.name) ? { name: peer.identityName ?? peer.name } : {}),
    });
  }
  if (pending.size === 0) return 0;

  let repaired = 0;
  // Hold the shared identity.json lock for the entire read→write→verify
  // section, so no concurrent register()/unregister()/repair can interleave a
  // read-merge-write and lose an entry. The per-iteration re-read below is
  // retained as defense-in-depth (and to converge if a non-locking writer ever
  // lands), but the lock is what actually closes the lost-update window.
  const runRepair = (): number => {
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
    return repaired;
  };

  // Hold the shared identity.json lock (STRICT) for the entire read→write→verify
  // section so no concurrent register()/unregister()/repair can interleave a
  // read-merge-write and lose an entry. STRICT is what the review asked for: a
  // lock timeout must not silently run the section unheld. On timeout we degrade
  // LOUDLY — run it once, unheld, and warn — matching IdentityManager.register()'s
  // contract (never crash on a lock failure; the atomic rename still lands).
  try {
    withFileLock(IDENTITY_FILE, runRepair, { strict: true });
  } catch (err) {
    if (!(err instanceof FileLockTimeoutError)) throw err;
    console.warn(
      `[mycc-compose] WARNING: could not acquire the identity.json lock (${err.message}); ` +
      'repairing WITHOUT cross-process exclusion — a concurrent register may be lost.',
    );
    runRepair();
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Identity cull pass (FIX C)
// ---------------------------------------------------------------------------

/**
 * Delete the identity.json entries of peers we have PROVABLY stopped, so the
 * store does not accumulate stale entries after `down`.
 *
 * WHY compose must do this: on Windows a peer is stopped with SIGTERM, which
 * the OS delivers as TerminateProcess — no handler runs, so the peer's OWN
 * `peer.stop()` → `unregister()` never executes. Its identity entry therefore
 * survives `down` (a dead twin that a later `up` re-materializes under a fresh
 * sid, transiently listing old+new entries for the same NAME). `repairIdentity`
 * is the backstop for the OPPOSITE failure (a live peer losing its entry
 * mid-race); it deliberately never deletes, so the cull must live here.
 *
 * EVIDENCE-GATED, DELETE-SIDE ONLY: an entry is culled ONLY when its recorded
 * pid is a NUMBER and PROVABLY DEAD (`peerPid` = heartbeat pid first, identity
 * pid fallback; `!isPidAlive(pid)`). A missing pid (unknown liveness) or an
 * alive pid (death unproven) KEEPS the entry — the same discipline cmd-down's
 * channel cleanup uses (`isSidDead`). Never resurrects: this pass only removes.
 *
 * RACE SAFETY: holds the SAME cross-process identity.json lock as
 * IdentityManager.register()/unregister() and repairIdentity, for the whole
 * read→delete→verify section, so a concurrent register() can never be
 * clobbered. Each iteration RE-READS the map before deleting (merge-on-read),
 * so an entry that (re)appeared since the last read is preserved. STRICT mode:
 * a lock timeout degrades LOUDLY (run once, unheld, warn) — it must never crash
 * the teardown.
 *
 * @param peers Peers whose stops have already been attempted. Only sids that
 *   are BOTH present in identity.json AND whose recorded pid is provably dead
 *   are removed.
 * @returns The number of identity entries culled.
 */
export function cullStoppedPeers(peers: Peer[]): number {
  // Candidate sids: peers that carry a resolved runtime sid and whose recorded
  // pid is provably dead. Unknown/absent sid → skip (nothing to key on).
  const candidates = new Set<string>();
  for (const peer of peers) {
    const sid = peer.sessionId;
    if (typeof sid !== 'string' || sid.length === 0) continue;
    const pid = peerPid(sid);
    if (typeof pid !== 'number' || isPidAlive(pid)) continue; // unknown/alive → keep
    candidates.add(sid);
  }
  if (candidates.size === 0) return 0;

  let culled = 0;
  // Read → delete → verify under the shared identity.json lock, re-reading
  // every iteration so a concurrent register() is merged, never clobbered.
  const runCull = (): number => {
    for (let attempt = 0; attempt < 5 && candidates.size > 0; attempt++) {
      const map = readIdentityMap();
      for (const sid of [...candidates]) {
        // Merge-on-read: only ever DELETE, never write back a stale snapshot.
        // Re-check death at delete time (the pid could have been recycled onto
        // a live process between the scan above and here) — a now-alive pid
        // aborts this sid's cull.
        if (!(sid in map)) {
          candidates.delete(sid); // already gone (or never registered) → done
          continue;
        }
        const pid = peerPid(sid);
        if (typeof pid === 'number' && !isPidAlive(pid)) {
          delete map[sid];
        } else {
          candidates.delete(sid); // became alive / unprovable → keep, stop trying
        }
      }
      writeIdentityMap(map);
      // Verify: a candidate is only "culled" once it is absent after the write.
      const after = readIdentityMap();
      for (const sid of [...candidates]) {
        if (!(sid in after)) {
          candidates.delete(sid);
          culled++;
        }
      }
    }
    return culled;
  };

  try {
    withFileLock(IDENTITY_FILE, runCull, { strict: true });
  } catch (err) {
    if (!(err instanceof FileLockTimeoutError)) throw err;
    console.warn(
      `[mycc-compose] WARNING: could not acquire the identity.json lock (${err.message}); ` +
      'culling stale identity entries WITHOUT cross-process exclusion — a concurrent register may be lost.',
    );
    runCull();
  }
  return culled;
}

// ---------------------------------------------------------------------------
// Sequenced-restart wait (P2 #1)
// ---------------------------------------------------------------------------

/**
 * Wait until a peer's previous holder has DEMONSTRABLY released its identity,
 * so a replacement can be launched without racing the old process's graceful
 * shutdown.
 *
 * WHY: `stopPeer()` sends SIGTERM and returns `'stopped'` the instant the signal
 * is DELIVERED — it does not wait for the process to exit. The old peer's own
 * SIGTERM handler still awaits background-task cleanup and ServeHub shutdown
 * before it exits and (on POSIX) unregisters. If `up` queues the replacement
 * immediately, the new process's `assertNameNotLive()` sees the old peer's
 * still-fresh heartbeat + live pid and REFUSES registration, surfacing as a
 * launch-timeout. Sequenced restart closes that window.
 *
 * "Gone" = BOTH proofs hold simultaneously:
 *   - no LIVE instance resolves for this peer's durable NAME (resolveLivePeer
 *     requires a fresh heartbeat AND an alive pid), AND
 *   - the previously-recorded heartbeat pid is dead (peerPid + !isPidAlive).
 * The second clause covers the window where the name already resolves to null
 * (heartbeat aged out / pid dead) but a stale entry could still block register.
 *
 * @returns true when the holder is demonstrably gone within `timeoutMs`; false
 *   on timeout (the caller must fail the restart explicitly, never launch).
 */
export async function waitForPeerGone(
  peer: Peer,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  // Capture the holder's sid BEFORE the wait: once the old process exits, the
  // name resolves to null and we would no longer know WHICH heartbeat to probe.
  const sid = (peer.sessionId as string | null | undefined) ?? resolveLivePeer(peer) ?? null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nameLive = resolveLivePeer(peer) !== null;
    let pidDead = true;
    if (sid) {
      const pid = peerPid(sid);
      // No recorded pid (the entry/heartbeat is already gone, or a legacy
      // writer that never stamped one) ⇒ nothing we can prove alive; the
      // name-resolution clause above is then the sole gate. This is the same
      // "absent = not a holder" reading assertNameNotLive uses (it iterates the
      // map, so a deleted entry cannot block registration).
      pidDead = typeof pid !== 'number' ? true : !isPidAlive(pid);
    }
    if (!nameLive && pidDead) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Per-peer status row: {name, sessionId, live, matching, lastBrief}. */
export function peerStatus(peer: Peer): PeerStatusRow {
  // Resolve the LIVE instance by durable name FIRST (stamps peer.sessionId),
  // so `sessionId`/`lastBrief` reflect the currently-running instance rather
  // than a stale spec/runtime sid. resolvePeerSid leaves peer.sessionId intact
  // when no live instance matches, so a down peer still reports its last-known
  // sid (when one was carried) instead of dropping to null.
  const resolved = resolvePeerSid(peer);
  const sid = resolved ?? peer.sessionId ?? null;
  return {
    name: peer.name as string,
    sessionId: sid,
    // "live" reflects an actually-running process (fresh heartbeat AND alive
    // pid), not merely a not-yet-expired heartbeat file.
    live: isPeerRunning({ sessionId: sid, workdir: peer.workdir }),
    matching: findMatchingLiveEntry(peer) !== null,
    lastBrief: sid ? lastBrief(sid) : null,
  };
}
