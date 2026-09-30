/**
 * cmd-up.ts — `mycc-compose up <file>` / `sync <file>`: full pipeline.
 *
 * `up` may stop then restart a mismatched peer; `sync` (allowStop:false) leaves
 * a mismatched peer running — the cron path is non-destructive.
 */

import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { validateSpec, loadSpec, updateSpecFile, getRemotes } from './spec.js';
import { materializeChannels } from './channels.js';
import { isPeerRunning } from './discovery.js';
import {
  findMatchingLiveEntry,
  launchPeer,
  stopPeer,
  repairIdentity,
  sleep,
  WAVE_SIZE,
  WAVE_DELAY_MS,
  LAUNCH_TIMEOUT_MS,
  LAUNCH_POLL_MS,
} from './peers.js';
import { out, warn } from './cli.js';
import type { NormalizedPeer, NormalizedSpec } from './spec.js';

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
 * docs/remotes-design-decision.md.
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
    const sid = peer.sessionId;
    if (!sid) {
      rows.push({ name: peer.name, ok: false, note: `remotes for ${peer.name} not delivered (peer has no session id)` });
      continue;
    }
    if (!isPeerRunning(peer)) {
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

  // §5 step 1 — assign UUIDs to sessionId:null peers, write back IN PLACE.
  const minted: string[] = [];
  for (const peer of spec.peers) {
    if (peer.sessionId === null) {
      peer.sessionId = randomUUID();
      minted.push(peer.name);
    }
  }
  if (minted.length > 0) {
    updateSpecFile(file, (raw) => {
      for (const p of raw.peers as Array<Record<string, unknown>>) {
        const norm = spec.peers.find((x) => x.name === p.name);
        if (norm && p.sessionId == null) p.sessionId = norm.sessionId;
      }
    });
    out(`Minted session ids for: ${minted.join(', ')} (written back to ${file}).`);
  }

  // §5 step 2 — walk peers in array order, decide skip / stop→start / start.
  const actions: Array<{ name: string; action: string }> = [];
  const toStart: NormalizedPeer[] = [];
  for (const peer of spec.peers) {
    const matching = findMatchingLiveEntry(peer);
    if (matching && peer.renew === 'onMismatch') {
      actions.push({ name: peer.name, action: 'skip (live + match)' });
      continue;
    }
    if (matching && peer.renew === 'always') {
      const stopResult = stopPeer(peer);
      actions.push({ name: peer.name, action: `renew:always → stop=${stopResult}, start` });
      toStart.push(peer);
      continue;
    }
    if (isPeerRunning(peer)) {
      // Actually running but args/workdir differ. `up` stops then starts;
      // `sync` leaves it (no destructive stop in the cron path).
      if (allowStop) {
        const stopResult = stopPeer(peer);
        actions.push({ name: peer.name, action: `mismatch → stop=${stopResult}, start` });
        toStart.push(peer);
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
  const stillDown: string[] = [];
  for (const peer of spec.peers) {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (!isPeerRunning(peer) && Date.now() < deadline) {
      await sleep(LAUNCH_POLL_MS);
    }
    if (!isPeerRunning(peer)) stillDown.push(peer.name);
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
  process.exit(launchResults.some((r) => !r.ok) || stillDown.length > 0 ? 1 : 0);
}