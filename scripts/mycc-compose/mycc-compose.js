#!/usr/bin/env node
/**
 * mycc-compose.js — Declarative peer-group orchestrator for mycc (CLI entry).
 *
 * Reads a JSON *topology spec* describing a group of mycc peers (how to launch
 * them, which channels connect them) and materializes it deterministically:
 * launch/renew members, mint or reuse their session ids, write both channel
 * files per link, and report status. Re-running the tool is the resume path
 * (cron / `--daemon <skill>` + `service_cron`). No LLM is in the loop.
 *
 * This is the *automation* counterpart to the `mediator` skill: the skill
 * describes, in prose, how to wire instances by hand; this script is that
 * procedure compiled into an idempotent CLI.
 *
 * Zero-dependency ESM, mirroring scripts/mycc-mail/mycc-mail.js: it only
 * imports node built-ins plus project plain-`.js` modules (the shared arg table
 * and the lib/ siblings), all loadable by a plain `node` process without tsx.
 *
 * THIS FILE IS THE THIN CLI LAYER (like scripts/mdcalc/mdcalc.js). All logic
 * lives in the sibling modules:
 *
 *   lib/discovery.js  identity/heartbeat readers + liveness predicates
 *   lib/spec.js       spec load + validate (schema v2) — pure, unit-tested
 *   lib/channels.js   channel-file materialization / removal / status
 *   lib/peers.js      launch / stop / match / repair
 *   lib/cli.js        usage text, arg parsing, exit helpers
 *
 * Exposed as the `mycc-compose` bin by the parent mycc package
 * (see ../../package.json `bin`).
 *
 *   mycc-compose check  <file>          validate + report match, no mutation
 *   mycc-compose up     <file>          full pipeline (launch/renew + channels)
 *   mycc-compose sync   <file>          idempotent reconcile (up minus stops) — cron target
 *   mycc-compose down   <file> [--stop] remove channels; optionally stop peers
 *   mycc-compose status <file> [--json] deterministic report
 *   mycc-compose --help
 *
 * Run directly during development:
 *   node scripts/mycc-compose/mycc-compose.js check spec.json
 */

import { randomUUID } from 'crypto';

import { validateSpec, loadSpec, updateSpecFile } from './lib/spec.js';
import { materializeChannels, removeChannels, channelStatus, channelFileNames } from './lib/channels.js';
import { isPeerRunning } from './lib/discovery.js';
import {
  findMatchingLiveEntry,
  peerStatus,
  launchPeer,
  stopPeer,
  repairIdentity,
  sleep,
  WAVE_SIZE,
  WAVE_DELAY_MS,
  LAUNCH_TIMEOUT_MS,
  LAUNCH_POLL_MS,
} from './lib/peers.js';
import { HELP, dieUsage, dieError, out, warn, parseCliArgs } from './lib/cli.js';

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdCheck(file) {
  const spec = validateSpec(loadSpec(file));
  out(`Spec OK (group "${spec.group}", ${spec.peers.length} peers, ${spec.channels.length} channels).`);
  for (const peer of spec.peers) {
    const st = peerStatus(peer);
    const verdict = st.matching ? 'match' : st.live ? 'mismatch' : 'stale';
    out(
      `  - ${peer.name}: ${verdict}` +
      ` [sid=${st.sessionId ?? '(none)'}, live=${st.live}, args="${peer.args}"]`,
    );
  }
  if (spec.channels.length > 0) {
    for (const ch of channelStatus(spec)) {
      out(`  - channel ${ch.label}: ${ch.bothFilesPresent ? 'both files present' : 'incomplete'}`);
    }
  }
  process.exit(0);
}

async function cmdUp(file, { allowStop }) {
  const spec = validateSpec(loadSpec(file));

  // §5 step 1 — assign UUIDs to sessionId:null peers, write back IN PLACE.
  const minted = [];
  for (const peer of spec.peers) {
    if (peer.sessionId === null) {
      peer.sessionId = randomUUID();
      minted.push(peer.name);
    }
  }
  if (minted.length > 0) {
    updateSpecFile(file, (raw) => {
      for (const p of raw.peers) {
        const norm = spec.peers.find((x) => x.name === p.name);
        if (norm && p.sessionId == null) p.sessionId = norm.sessionId;
      }
    });
    out(`Minted session ids for: ${minted.join(', ')} (written back to ${file}).`);
  }

  // §5 step 2 — walk peers in array order, decide skip / stop→start / start.
  const actions = [];
  const toStart = [];
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
  const launchResults = [];
  for (let i = 0; i < toStart.length; i += WAVE_SIZE) {
    const wave = toStart.slice(i, i + WAVE_SIZE);
    const settled = await Promise.allSettled(wave.map((p) => launchPeer(p)));
    settled.forEach((r, j) => {
      const peer = wave[j];
      if (r.status === 'fulfilled') launchResults.push({ name: peer.name, ok: true });
      else launchResults.push({ name: peer.name, ok: false, error: r.reason.message });
    });
    if (i + WAVE_SIZE < toStart.length) await sleep(WAVE_DELAY_MS);
  }

  // Wait for all peers to be reachable, then repair identity (§5 step 3).
  const stillDown = [];
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

function cmdDown(file, stop) {
  const spec = validateSpec(loadSpec(file));
  // Remove exactly the files this spec owns — never a foreign peer's channel.
  const removed = removeChannels(channelFileNames(spec));
  out(`mycc-compose down: removed ${removed} channel file(s).`);
  if (stop) {
    for (const peer of spec.peers) {
      out(`  - ${peer.name}: ${stopPeer(peer)}`);
    }
  }
  process.exit(0);
}

function cmdStatus(file, asJson) {
  const spec = validateSpec(loadSpec(file));
  const report = {
    group: spec.group,
    generatedAt: new Date().toISOString(),
    peers: spec.peers.map((peer) => {
      const p = peerStatus(peer);
      return {
        name: p.name,
        sessionId: p.sessionId,
        live: p.live,
        matching: p.matching,
        lastBrief: p.lastBrief
          ? { time: p.lastBrief.time, content: p.lastBrief.content, confidence: p.lastBrief.confidence }
          : null,
      };
    }),
    channels: channelStatus(spec),
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  }
  out(`Topology "${report.group}" @ ${report.generatedAt}`);
  out('Peers:');
  for (const p of report.peers) {
    out(`  - ${p.name}: ${p.live ? 'live' : 'down'}${p.live && !p.matching ? ' (args/workdir mismatch)' : ''} [sid=${p.sessionId ?? '(none)'}]`);
    if (p.lastBrief) {
      const when = new Date(p.lastBrief.time).toISOString().replace('T', ' ').slice(0, 19);
      out(`      last brief (${when}, conf=${p.lastBrief.confidence}): ${p.lastBrief.content}`);
    }
  }
  out('Channels:');
  for (const c of report.channels) {
    out(`  - ${c.label}: ${c.bothFilesPresent ? 'intact' : 'incomplete'}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    dieUsage(err.message);
  }
  if (args.help || args.command === null) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  if (args.file === null) dieUsage(`command "${args.command}" requires a <file> argument`);

  switch (args.command) {
    case 'check':
      cmdCheck(args.file);
      break;
    case 'up':
      await cmdUp(args.file, { allowStop: true });
      break;
    case 'sync':
      await cmdUp(args.file, { allowStop: false });
      break;
    case 'down':
      cmdDown(args.file, args.stop);
      break;
    case 'status':
      cmdStatus(args.file, args.json);
      break;
    default:
      dieUsage(`unknown command: ${args.command}`);
  }
}

main().catch((err) => dieError(err && err.message ? err.message : String(err)));
