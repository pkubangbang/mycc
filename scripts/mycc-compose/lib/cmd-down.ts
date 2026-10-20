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
import { removeChannels, channelFileNames } from './channels.js';
import { resolvePeerSid } from './peers.js';
import { cullStoppedPeers } from './peers-state.js';
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

  // Channel cleanup — NAME → SID → FILENAME, then best-effort unlinking.
  //
  // The filename is the ONLY ownership key: a channel file is
  // `<sid>-<label>.json`, so the files this spec owns are exactly one name per
  // (peer, channel) pair, where the sid comes from the peer's resolved live
  // instance (step 1 above) — falling back to the sid the stop primitive
  // resolved (`peer.sessionId`, stamped above), then to whatever sid the peer
  // record already carries from a previous `up`.
  //
  // The FILE CONTENT is never read, compared or used to decide ownership: names
  // (ownerName/peerName) are persistent and CAN coincide across topologies that
  // share a group name, which made the old content-based "either name matches"
  // rule delete another topology's file (audit finding AC-5). A sid is unique
  // per run, so the filename is unambiguous by construction.
  //
  // Best-effort: unlink failures (a peer still holding the handle on Windows, a
  // permissions error) are reported and do not change the exit code or abort the
  // teardown — the peers are already stopped by this point.
  const ownedFiles = channelFileNames(spec);
  const { removed, failed } = removeChannels(ownedFiles);
  out(`mycc-compose down: removed ${removed} channel file(s).`);
  if (failed.length > 0) {
    out(`  could not remove ${failed.length} channel file(s) (best-effort, ignored): ${failed.join(', ')}`);
  }

  // EXIT CONTRACT (owner decision) — `down` distinguishes COMPLETE from PARTIAL
  // teardown:
  //   0 = fully done: every peer located+stopped AND every declared channel
  //       pair accounted for (expected === actual).
  //   1 = partial: the peers were found and closed, but actual < expected —
  //       some channel file the spec says exists could not be named or could
  //       not be unlinked. The teardown is NOT complete even though the stop
  //       half succeeded (finding N1).
  //
  // `expected` is derived from the SPEC (two files per declared channel), not
  // from `ownedFiles` — an empty filename set must not self-certify as success.
  const expected = spec.channels.length * 2;
  const actual = ownedFiles.length;
  const incomplete = actual < expected || failed.length > 0;

  if (incomplete) {
    out(
      `  INCOMPLETE: expected ${expected} channel file(s) from the spec, ` +
      `could account for ${actual}${failed.length > 0 ? ` (${failed.length} unlink failure(s))` : ''}. ` +
      `Some peers did not resolve to a session, so their files were left in place.`,
    );
  }

  process.exit(stopFailures > 0 || incomplete ? 1 : 0);
}