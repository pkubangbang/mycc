/**
 * cmd-down.ts — `mycc-compose down <file> [--stop]`: remove channel pairs;
 * with --stop, terminate the peers.
 *
 * ORDER AND EXIT CONTRACT: the channels are a running peer's IPC surface —
 * deleting them is what actually tears a peer's topology down. When --stop is
 * requested the stop attempt happens FIRST, so a peer that IS successfully
 * stopped is not left with dead channels for even a moment.
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
 * The exit code mirrors what actually happened: 0 = every requested stop
 * succeeded (or the peer was already not running); 1 = at least one requested
 * stop was REFUSED. Channel removal itself does not affect the exit code.
 */

import { validateSpec, loadSpec } from './spec.js';
import { removeChannels, channelFileNames } from './channels.js';
import { stopPeer } from './peers.js';
import { out } from './cli.js';

export function cmdDown(file: string, stop: boolean): void {
  const spec = validateSpec(loadSpec(file));

  let stopFailures = 0;
  const stopResults: string[] = [];
  if (stop) {
    // Stop before deleting: the channel files are how the peers receive
    // work; attempting the stop FIRST means a peer that IS stopped is never
    // left with dead channels. A refused stop does NOT skip the deletion
    // below — the deletion is the operator's explicit teardown request and the
    // refusal surfaces only as a non-zero exit (see the file header).
    for (const peer of spec.peers) {
      const result = stopPeer(peer);
      out(`  - ${peer.name}: ${result}`);
      stopResults.push(`${peer.name} (${result})`);
      const stopped = result === 'stopped' || result === 'already-stopped';
      if (!stopped) stopFailures++;
    }
    if (stopFailures > 0) {
      out(`  stop refused for ${stopFailures} peer(s): ${stopResults.join(', ')}`);
    }
  }

  // Remove exactly the files this spec owns — never a foreign peer's channel.
  const removed = removeChannels(channelFileNames(spec));
  out(`mycc-compose down: removed ${removed} channel file(s).`);

  process.exit(stopFailures > 0 ? 1 : 0);
}