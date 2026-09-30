/**
 * cmd-up.ts — `mycc-compose up <file>` / `sync <file>`: full pipeline.
 *
 * `up` may stop then restart a mismatched peer; `sync` (allowStop:false) leaves
 * a mismatched peer running — the cron path is non-destructive.
 */

import { randomUUID } from 'crypto';
import { validateSpec, loadSpec, updateSpecFile } from './spec.js';
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
import type { NormalizedPeer } from './spec.js';

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

  // §5 step 4 — materialize channels.
  const channelResults = materializeChannels(spec);

  // §5 step 5 — report.
  out('mycc-compose up:');
  for (const a of actions) out(`  - ${a.name}: ${a.action}`);
  for (const r of launchResults) {
    if (!r.ok) out(`  - ${r.name}: LAUNCH FAILED — ${r.error}`);
  }
  if (repaired > 0) out(`  - identity repair pass: reconstituted ${repaired} entr${repaired === 1 ? 'y' : 'ies'}`);
  for (const c of channelResults) {
    out(`  - channel ${c.label}: ${c.ok ? 'written (pair)' : `SKIPPED (${c.reason})`}`);
  }
  if (stillDown.length > 0) {
    warn(`Warning: peers not live after ${LAUNCH_TIMEOUT_MS}ms: ${stillDown.join(', ')}`);
  }
  process.exit(launchResults.some((r) => !r.ok) || stillDown.length > 0 ? 1 : 0);
}