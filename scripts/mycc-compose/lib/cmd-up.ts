/**
 * cmd-up.ts — `mycc-compose up <file>` / `sync <file>`: full pipeline.
 *
 * `up` may stop then restart a mismatched peer; `sync` (allowStop:false) leaves
 * a mismatched peer running — the cron path is non-destructive.
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { validateSpec, loadSpec, getRemotes } from './spec.js';
import { materializeChannels } from './channels.js';
import { isPeerRunning } from './discovery.js';
import {
  findMatchingLiveEntry,
  resolvePeerSid,
  launchPeer,
  stopPeer,
  repairIdentity,
  waitForPeerGone,
  sleep,
  WAVE_SIZE,
  WAVE_DELAY_MS,
  LAUNCH_TIMEOUT_MS,
  LAUNCH_POLL_MS,
} from './peers.js';
import { out, warn } from './cli.js';
import type { NormalizedPeer, NormalizedSpec } from './spec.js';

/**
 * How long `up` waits for a stopped peer's PREVIOUS holder to demonstrably
 * release its identity before launching the replacement. `stopPeer` returns as
 * soon as SIGTERM is delivered; the old process's own SIGTERM handler may still
 * be running (bg-kill + ServeHub stop) and its fresh heartbeat + live pid would
 * make the replacement's `assertNameNotLive()` refuse registration — surfacing
 * as a launch timeout. Bounded so a stuck holder fails the restart explicitly
 * instead of hanging `up` forever.
 */
const RESTART_RELEASE_TIMEOUT_MS = 5_000;

/**
 * Resolve the absolute path to the mycc-mail CLI script, anchored on THIS
 * module's location (scripts/mycc-compose/lib/cmd-up.ts →
 * scripts/mycc-mail/mycc-mail.js) so it works regardless of the caller's cwd.
 */
const MYCC_MAIL_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'mycc-mail',
  'mycc-mail.js',
);

/**
 * Compose the imperative, no-question instruction a peer receives carrying its
 * remote URL list. The peer's lead owns the live dial set at runtime: it calls
 * `peer_connect(url)` for each URL, then `peer_list` + `mail_to` to talk to the
 * discovered remote sid. The instruction forbids ending the turn with a
 * question (a stalled --auto peer does not drain its mailbox) and tells the
 * peer to stop once all dials are attempted — the stall-immune shape per
 * docs/peers/remotes-design-decision.md.
 */
function remotesMailContent(peer: NormalizedPeer): string {
  const urls = getRemotes(peer).map((u) => `  - ${u}`).join('\n');
  return (
    `[Remotes] This peer should dial the following remote mycc instance(s) ` +
    `over the WebSocket peer-wire:\n\n${urls}\n\n` +
    `For each URL: call peer_connect(url). Then run peer_list to discover each ` +
    `remote's session id, and mail_to(\"<discoveredSid>/lead\") to talk to it.\n` +
    `Do NOT ask the user anything; do NOT end your turn with a question. When ` +
    `all dials are attempted, report the connected peers and stop.`
  );
}

/**
 * STEP 3 — deliver each live peer's declared `remotes` to its own mailbox via
 * mycc-mail (spawned with --require-online so the append is gated on the peer
 * being PROVABLY live: fresh heartbeat + recorded pid alive). The peer is
 * freshly up at this point so the gate passes; if a peer is NOT live (launch
 * failed or slow), mycc-mail exits non-zero and we print a fail-loud message
 * and CONTINUE with the other peers — never abort the whole `up` over one
 * peer's undelivered remotes. Returns the per-peer delivery rows for reporting.
 */
function deliverRemotes(spec: NormalizedSpec): Array<{ name: string; ok: boolean; note: string }> {
  const rows: Array<{ name: string; ok: boolean; note: string }> = [];
  for (const peer of spec.peers) {
    const peerRemotes = getRemotes(peer);
    if (peerRemotes.length === 0) continue;
    // Resolve the LIVE sid by durable NAME. The sid must be the peer's REAL
    // one — a launcher-minted phantom would gate `--require-online` on a
    // heartbeat file that never exists.
    const sid = resolvePeerSid(peer);
    if (!sid) {
      rows.push({ name: peer.name, ok: false, note: `remotes for ${peer.name} not delivered (peer has no session id)` });
      continue;
    }
    if (!isPeerRunning({ sessionId: sid, workdir: peer.workdir })) {
      rows.push({ name: peer.name, ok: false, note: `remotes for ${peer.name} not delivered (peer not live)` });
      continue;
    }
    try {
      // Invoke the mailer as a CHILD PROCESS (the compose CLI is a node script;
      // importing the .js would run its top-level `main()` and exit). Capture
      // the exit code: 0 = delivered, non-zero = liveness gate refused.
      execFileSync(
        process.execPath,
        [MYCC_MAIL_SCRIPT, sid, '--title', 'remotes', '--content', remotesMailContent(peer), '--from', 'mycc-compose', '--require-online'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      rows.push({ name: peer.name, ok: true, note: `remotes delivered (${peerRemotes.length} URL${peerRemotes.length === 1 ? '' : 's'})` });
    } catch (err) {
      // Non-zero exit = liveness gate refused (peer not live) OR a delivery
      // error. Either way, fail loud per peer and continue.
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({ name: peer.name, ok: false, note: `remotes for ${peer.name} not delivered (peer not live): ${msg}` });
    }
  }
  return rows;
}

export async function cmdUp(file: string, { allowStop }: { allowStop: boolean }): Promise<void> {
  const spec = validateSpec(loadSpec(file));

  // Peers no longer carry a spec-authored or launcher-minted session id: a
  // launched peer mints its OWN fresh sid on boot and registers it under its
  // durable `--name`. So there is NOTHING to resolve or mint BEFORE launch —
  // the launch list is simply every peer, and resolution by NAME happens AFTER
  // launch (see the liveness-wait / deliverRemotes / repairIdentity below).

  // §5 step 2 — walk peers in array order, decide skip / stop→start / start.
  // The restart branches are SEQUENCED: after stopPeer returns 'stopped', we
  // wait (bounded) for the previous holder to demonstrably release its
  // identity before queueing the replacement — a successful SIGTERM delivery
  // is NOT proof of termination. A refusal/kill-failure never queues a launch
  // (the duplicate-name guard would only reject it); it surfaces as a failure.
  const actions: Array<{ name: string; action: string }> = [];
  const toStart: NormalizedPeer[] = [];
  const restartFailures: string[] = [];

  /**
   * Handle a peer that must be (re)started by stopping the current holder first.
   * Returns the peers to queue for launch (empty when the stop refused or the
   * holder did not release in time).
   */
  const stopThenQueue = async (peer: NormalizedPeer, reason: string): Promise<boolean> => {
    const stopResult = stopPeer(peer);
    if (stopResult === 'refused-no-recorded-pid' || stopResult.startsWith('refused-')) {
      actions.push({ name: peer.name, action: `${reason} → stop=${stopResult}, restart ABORTED (refused)` });
      restartFailures.push(peer.name);
      return false;
    }
    if (stopResult.startsWith('kill-failed:')) {
      actions.push({ name: peer.name, action: `${reason} → stop=${stopResult}, restart ABORTED (kill failed)` });
      restartFailures.push(peer.name);
      return false;
    }
    // 'stopped' → wait for the holder to demonstrably release its identity.
    // 'already-stopped'/'no-session' → already gone, no wait needed. (A
    // 'stale-kept-alive-pid'/'heartbeat-fresh-but-pid-dead' result means a live
    // pid we did not kill: waitForPeerGone will time out and we abort.)
    if (stopResult === 'stopped' || stopResult === 'stale-kept-alive-pid' || stopResult === 'heartbeat-fresh-but-pid-dead') {
      const gone = await waitForPeerGone(peer, RESTART_RELEASE_TIMEOUT_MS);
      if (!gone) {
        actions.push({ name: peer.name, action: `${reason} → stop=${stopResult}, restart ABORTED (previous peer did not release its identity within ${RESTART_RELEASE_TIMEOUT_MS}ms)` });
        restartFailures.push(peer.name);
        return false;
      }
    }
    actions.push({ name: peer.name, action: `${reason} → stop=${stopResult}, start` });
    return true;
  };

  for (const peer of spec.peers) {
    const matching = findMatchingLiveEntry(peer);
    if (matching && peer.renew === 'onMismatch') {
      actions.push({ name: peer.name, action: 'skip (live + match)' });
      continue;
    }
    if (matching && peer.renew === 'always') {
      // renew:always wants a fresh start — but only `up` may stop a running
      // peer. `sync` (allowStop:false) must leave it running; a cron tick that
      // recycled live peers would defeat the reconciler's purpose.
      if (!allowStop) {
        actions.push({ name: peer.name, action: 'renew:always (sync: left running, no stop)' });
        continue;
      }
      if (await stopThenQueue(peer, 'renew:always')) toStart.push(peer);
      continue;
    }
    if (isPeerRunning(peer)) {
      // Actually running but args/workdir differ. `up` stops then starts;
      // `sync` leaves it (no destructive stop in the cron path).
      if (allowStop) {
        if (await stopThenQueue(peer, 'mismatch')) toStart.push(peer);
      } else {
        actions.push({ name: peer.name, action: 'mismatch (sync: left running, no stop)' });
      }
      continue;
    }
    actions.push({ name: peer.name, action: 'start' });
    toStart.push(peer);
  }

  // Launch in staged waves (§5: ~20 at once loses identity entries).
  const launchResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (let i = 0; i < toStart.length; i += WAVE_SIZE) {
    const wave = toStart.slice(i, i + WAVE_SIZE);
    const settled = await Promise.allSettled(wave.map((p) => launchPeer(p)));
    settled.forEach((r, j) => {
      const peer = wave[j];
      if (r.status === 'fulfilled') launchResults.push({ name: peer.name, ok: true });
      else launchResults.push({ name: peer.name, ok: false, error: (r.reason as Error).message });
    });
    if (i + WAVE_SIZE < toStart.length) await sleep(WAVE_DELAY_MS);
  }

  // Wait for all peers to be reachable, then repair identity (§5 step 3).
  // Liveness is judged by RESOLVING THE NAME each tick (the peer minted its own
  // fresh sid on boot, so only the live instance's sid — stamped onto the peer
  // by resolvePeerSid — is trustworthy for a slow/failed launch).
  const stillDown: string[] = [];
  for (const peer of spec.peers) {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (resolvePeerSid(peer) === null && Date.now() < deadline) {
      await sleep(LAUNCH_POLL_MS);
    }
    if (resolvePeerSid(peer) === null) stillDown.push(peer.name);
  }
  const repaired = repairIdentity(spec.peers);

  // §5 step 3b — deliver each live peer's declared remotes to its mailbox via
  // mycc-mail (gated by --require-online). Runs AFTER liveness-wait +
  // repairIdentity so freshly-up peers pass the gate; a not-live peer is
  // reported fail-loud and skipped (never aborts the whole up).
  //
  // GATED to `up` (allowStop:true) only — NOT `sync`. Reason: `sync` is the
  // cron reconciliation path (called with allowStop:false); re-appending the
  // remotes mail on every 5-min tick is wasteful and would flood the peer's
  // mailbox with duplicate [MAIL] notes. `up` is the initial bring-up, the one
  // place remotes need to be handed to a freshly-started peer. A peer that was
  // skipped (already live + matching) on a later `up` re-run will simply get a
  // second copy — harmless (the lead dedupes by processing the first), and the
  // spec author can change remotes and re-run `up` to push the new list.
  const remoteRows = allowStop ? deliverRemotes(spec) : [];

  // §5 step 4 — materialize channels.
  const channelResults = materializeChannels(spec);

  // §5 step 5 — report.
  out('mycc-compose up:');
  for (const a of actions) out(`  - ${a.name}: ${a.action}`);
  for (const r of launchResults) {
    if (!r.ok) out(`  - ${r.name}: LAUNCH FAILED — ${r.error}`);
  }
  if (repaired > 0) out(`  - identity repair pass: reconstituted ${repaired} entr${repaired === 1 ? 'y' : 'ies'}`);
  for (const r of remoteRows) {
    out(`  - ${r.name}: ${r.note}`);
  }
  for (const c of channelResults) {
    out(`  - channel ${c.label}: ${c.ok ? 'written (pair)' : `SKIPPED (${c.reason})`}`);
  }
  if (stillDown.length > 0) {
    warn(`Warning: peers not live after ${LAUNCH_TIMEOUT_MS}ms: ${stillDown.join(', ')}`);
  }
  if (restartFailures.length > 0) {
    warn(`Warning: restart aborted for ${restartFailures.length} peer(s): ${restartFailures.join(', ')}`);
  }
  process.exit(
    launchResults.some((r) => !r.ok) || stillDown.length > 0 || restartFailures.length > 0 ? 1 : 0,
  );
}