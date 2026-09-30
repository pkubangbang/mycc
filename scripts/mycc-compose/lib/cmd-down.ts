/**
 * cmd-down.ts — `mycc-compose down <file> [--stop]`: remove channel pairs;
 * with --stop, terminate the peers.
 */

import { validateSpec, loadSpec } from './spec.js';
import { removeChannels, channelFileNames } from './channels.js';
import { stopPeer } from './peers.js';
import { out } from './cli.js';

export function cmdDown(file: string, stop: boolean): void {
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