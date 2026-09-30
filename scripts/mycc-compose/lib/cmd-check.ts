/**
 * cmd-check.ts — `mycc-compose check <file>`: validate + report, no mutation.
 */

import { validateSpec, loadSpec } from './spec.js';
import { channelStatus } from './channels.js';
import { peerStatus } from './peers.js';
import { out } from './cli.js';

export function cmdCheck(file: string): void {
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