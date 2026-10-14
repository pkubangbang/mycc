/**
 * cmd-down.ts — `mycc-compose down <file>`: terminate the peers, then remove
 * their channel pairs.
 *
 * `down` ALWAYS STOPS THE PEERS. Removing the channel files alone has no
 * meaning — the channels are a running peer's IPC surface, so tearing the
 * topology down means stopping the peers first. There is no channels-only
 * mode; the stop is unconditional.
 *
 * ORDER AND EXIT CONTRACT: the channels are a running peer's IPC surface —
 * deleting them is what actually tears a peer's topology down. The stop
 * attempt happens FIRST, so a peer that IS successfully stopped is not left
 * with dead channels for even a moment.
 *
 * CHANNELS ARE REMOVED EVEN WHEN A STOP IS REFUSED/FAILED. The two outcomes are
 * deliberately decoupled: `down` is the operator's teardown verb, and removing
 * its declared channels is the explicit request. A refused stop (identity
 * unverifiable, recycled pid, kill failed) does NOT veto the deletion — it
 * only surfaces as a NON-ZERO exit so scripts/cron can see the failure. (Note
 * this means a refused-but-running peer may be left running with its IPC
 * surface removed; that is the intended semantics, not an oversight — the
 * operator asked for teardown and is told the stop failed via exit 1.)
 *
 * The exit code mirrors what actually happened: 0 = every stop succeeded (or
 * the peer was already not running); 1 = at least one stop was REFUSED.
 * Channel removal itself does not affect the exit code.
 */

import { validateSpec, loadSpec } from './spec.js';
import { removeChannels, ownedChannelFiles } from './channels.js';
import { resolvePeerSid, stopPeer } from './peers.js';
import { cullStoppedPeers } from './peers-state.js';
import { peerPid, isPidAlive, waitForPidDeath } from './discovery.js';
import { out } from './cli.js';

export function cmdDown(file: string): void {
  const spec = validateSpec(loadSpec(file));

  // Resolve each peer's LIVE session id by its durable NAME before touching
  // channels: the channel files are named `<sid>-<label>.json` and a spec no
  // longer authors a sid, so without this the filename set would be empty and
  // `down` would remove NOTHING (leaving the peers' IPC surface behind). The
  // same name-resolution pass cmdUp runs at step 0.
  for (const peer of spec.peers) {
    resolvePeerSid(peer);
  }

  let stopFailures = 0;
  const stopResults: string[] = [];
  // Stop before deleting: the channel files are how the peers receive work;
  // attempting the stop FIRST means a peer that IS stopped is never left with
  // dead channels. A refused stop does NOT skip the deletion below — the
  // deletion is the operator's explicit teardown request and the refusal
  // surfaces only as a non-zero exit (see the file header).
  const killedPids: number[] = [];
  for (const peer of spec.peers) {
    const result = stopPeer(peer);
    out(`  - ${peer.name}: ${result}`);
    stopResults.push(`${peer.name} (${result})`);
    // Record pids we actually SIGTERM'd so the cull below can give signal
    // delivery a bounded moment to settle (POSIX SIGTERM delivery is async).
    if (result === 'stopped') {
      // Read via an explicit cast: NormalizedPeer carries an index signature
      // ([key: string]: unknown), so `peer.sessionId` resolves THROUGH it to
      // `{}` rather than its declared `string | null` (see spec.ts getRemotes).
      const sid = peer.sessionId as string | null | undefined;
      if (sid) {
        const pid = peerPid(sid);
        if (typeof pid === 'number') killedPids.push(pid);
      }
    }
    // 'no-session' = no live instance could be resolved for this peer's NAME
    // (identity.json has no running entry) → there is nothing to stop, the
    // same success semantics as 'already-stopped'. 'stopped' = we terminated it.
    // Every OTHER result is a genuine refusal/failure (refused-*, kill-failed:*).
    const notAProblem = result === 'stopped' || result === 'already-stopped' || result === 'no-session';
    if (!notAProblem) stopFailures++;
  }
  if (stopFailures > 0) {
    out(`  stop refused for ${stopFailures} peer(s): ${stopResults.join(', ')}`);
  }

  // FIX C: cull the identity entries of peers we have PROVABLY stopped. On
  // Windows SIGTERM is delivered as TerminateProcess (no handler runs), so a
  // stopped peer's OWN unregister() never executes and its identity entry
  // survives `down` — a dead twin that a later `up` re-materializes under a
  // fresh sid, transiently listing old+new entries for the same NAME.
  //
  // Before scanning, give the SIGTERM'd pids a BOUNDED moment to actually die
  // (POSIX signal delivery is async; a check run too early would keep a
  // cullable entry). cullStoppedPeers is then evidence-gated (delete only when
  // the recorded pid is provably dead) and lock-guarded; a refused stop — or a
  // pid still alive at the deadline — leaves its entry in place.
  for (const pid of killedPids) waitForPidDeath(pid);
  const culled = cullStoppedPeers(spec.peers);
  out(`  culled ${culled} stale identity entr${culled === 1 ? 'y' : 'ies'}`);

  // Remove exactly the files this spec OWNS — judged by NAME (R1 conjunction:
  // label ∈ spec labels AND ownerName/peerName ∈ the spec's <group>:<peer>
  // name-set), plus an orphan-only legacy sweep (R2: a pre-v3 nameless file is
  // deletable ONLY when BOTH embedded sids are dead; ambiguity → kept +
  // reported). This replaces the old sid-keyed channelFileNames(): a channel
  // file's identity now survives the per-run sid churn by NAME, so cleanup no
  // longer depends on resolving today's sids.
  //
  // isSidDead requires positive evidence that the recorded PID no longer exists;
  // stale/missing heartbeat state alone is not proof of process death.
  // A stale/missing heartbeat does NOT prove the owning process is dead. For
  // legacy files we require a recorded PID and positive evidence that the OS
  // no longer has that process; unknown liveness fails closed.
  const isSidDead = (sid: string): boolean => {
    const pid = peerPid(sid);
    return typeof pid === 'number' && !isPidAlive(pid);
  };
  const { deletable, keptAmbiguous } = ownedChannelFiles(spec, isSidDead);
  const removed = removeChannels(deletable);
  out(`mycc-compose down: removed ${removed} channel file(s).`);
  if (keptAmbiguous.length > 0) {
    // Half-matches are NOT deletable evidence — they are investigation
    // material. A legacy (nameless) file still claimable by a live/unsettled
    // sid is left in place and surfaced here.
    out(
      `  kept ${keptAmbiguous.length} legacy channel file(s) with a live or ` +
      `unestablished sid (ambiguous ownership): ${keptAmbiguous.join(', ')}`,
    );
  }

  process.exit(stopFailures > 0 ? 1 : 0);
}