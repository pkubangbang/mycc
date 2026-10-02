/**
 * cmd-down.ts — `mycc-compose down <file> [--stop]`: remove channel pairs;
 * with --stop, terminate the peers.
 *
 * ORDER AND EXIT CONTRACT: the channels are a running peer's IPC surface —
 * deleting them while the peer still runs leaves it deaf. When --stop is
 * requested the stop happens FIRST; channels are deleted only afterwards.
 * The exit code mirrors what actually happened: 0 = channels removed and
 * every requested stop succeeded (or the peer was already not running);
 * 1 = a requested stop was REFUSED (identity unverifiable, recycled pid,
 * kill failed) — the caller (scripts, cron) must see the failure.
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
    // work; tearing the IPC surface down before the stop attempt would
    // strand a refused-but-running peer with dead channels.
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