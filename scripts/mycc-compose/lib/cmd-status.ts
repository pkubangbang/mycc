/**
 * cmd-status.ts — `mycc-compose status <file> [--json]`: deterministic report.
 */

import { validateSpec, loadSpec } from './spec.js';
import { channelStatus } from './channels.js';
import { peerStatus } from './peers.js';
import { out } from './cli.js';
import type { BriefEntry } from './discovery.js';

export function cmdStatus(file: string, asJson: boolean): void {
  const spec = validateSpec(loadSpec(file));
  const report = {
    group: spec.group,
    // `generatedAt` is intentionally NOT part of the machine-readable report:
    // `status --json` is documented as DETERMINISTIC (two identical invocations
    // must produce byte-identical JSON), and a wall-clock timestamp breaks that.
    // The human-readable form below still prints a timestamp (it is for a human).
    peers: spec.peers.map((peer) => {
      const p = peerStatus(peer);
      const lastBrief: { time: number; content: string; confidence: number } | null =
        p.lastBrief
          ? { time: (p.lastBrief as BriefEntry).time, content: (p.lastBrief as BriefEntry).content, confidence: (p.lastBrief as BriefEntry).confidence }
          : null;
      return {
        name: p.name,
        sessionId: p.sessionId,
        live: p.live,
        matching: p.matching,
        lastBrief,
      };
    }),
    channels: channelStatus(spec),
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  }
  out(`Topology "${report.group}" @ ${new Date().toISOString()}`);
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