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
import { resolvePeerSid } from './peers.js';
import { cullStoppedPeers } from './peers-state.js';
import { isSessionHolderDead } from './discovery.js';
import { stopPeerByAddress } from './peers-stop.js';
import { out } from './cli.js';

export async function cmdDown(file: string): Promise<void> {
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
  //
  // The stop is the shared stop-by-address primitive: it owns the whole
  // `address → sid → pid → signal → CONFIRM` chain, so `down` no longer
  // hand-collects pids or waits for death itself. By the time it returns
  // 'stopped', the process is provably gone — the cull below therefore needs no
  // extra settle-wait. Decision (i): a peer that was never started
  // (`refused-not-found`) is NOT a failure — there is simply nothing to stop —
  // so it exits 0 like 'already-stopped'.
  for (const peer of spec.peers) {
    const { verdict, sessionId } = await stopPeerByAddress({ cwd: peer.workdir, group: spec.group, name: peer.name });
    out(`  - ${peer.name}: ${verdict}`);
    stopResults.push(`${peer.name} (${verdict})`);
    // Stamp the resolved sid back onto the peer so the cull below can key on it:
    // cullStoppedPeers identifies the entry to delete by `peer.sessionId`, and
    // after a successful stop the peer's liveness evidence is gone, so the sid
    // must be captured HERE (the primitive resolved it) rather than re-derived
    // post-stop (which would find nothing).
    if (sessionId) peer.sessionId = sessionId;
    // Non-failure results: 'stopped' = terminated; 'already-stopped' = provably
    // gone; 'refused-not-found' = never registered (nothing to stop).
    // Every OTHER result is a genuine refusal/failure.
    const notAProblem = verdict === 'stopped' || verdict === 'already-stopped' || verdict === 'refused-not-found';
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
  // No settle-wait is needed here: stopPeerByAddress already CONFIRMED each
  // signaled pid is dead before returning 'stopped'. cullStoppedPeers is
  // evidence-gated (delete only when the recorded pid is provably dead) and
  // lock-guarded; a refused stop leaves its entry in place.
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
  // isSidDead requires positive evidence that the original holder is gone:
  // either its PID no longer exists or process-start evidence proves the PID was
  // reused. A stale/missing heartbeat alone is not proof of death; unknown or
  // conflicting PID evidence fails closed.
  const isSidDead = (sid: string): boolean => isSessionHolderDead(sid);
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