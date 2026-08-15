/**
 * channel.js — Channel file formatter for mycc-pretty-print
 *
 * A channel file (stored at ~/.mycc-store/discovery/channels/
 * [ownerSessionId]-[channelId].json) is the wire-format artifact that wires
 * two mycc instances into a mediated conversation. Its shape is the
 * ChannelFile interface (src/types.ts):
 *
 *   {
 *     channelId: string,
 *     ownerSessionId: string,
 *     peerSessionId: string | null,
 *     title: string,
 *     firstQuery: string | null,   // the opening message injected on join
 *     joined: boolean,
 *     firstQuerySent: boolean,
 *     createdAt: number            // ms since epoch
 *   }
 *
 * This formatter renders the file as a readable text block for terminal
 * display, so the agent can show a channel to the terminal user via:
 *
 *   bash(command="mycc-pretty-print --type=channel <path>", display=true)
 *
 * The display parameter briefs stdout to the terminal; the result never
 * re-enters the agent loop, so replaying a channel file is side-effect-free.
 */

import fs from 'fs';

/**
 * Format a channel file JSON for terminal display.
 *
 * Renders the header fields (channelId, title, peer, join state, created
 * date) followed by the firstQuery body (if present) under a labelled
 * separator. Unknown/missing optional fields degrade gracefully rather than
 * throwing, so a partially-written channel file still pretty-prints.
 *
 * @param {string} filePath - absolute or relative path to the channel JSON file
 * @returns {string} the formatted channel text
 * @throws if the file cannot be read or parsed as JSON
 */
export function format(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error(`File is not valid JSON: ${filePath}`);
  }

  // Validate the channel signature: channelId and ownerSessionId are the
  // minimal required fields. peerSessionId/title/firstQuery/joined/
  // firstQuerySent/createdAt are optional and rendered defensively.
  if (typeof record.channelId !== 'string' || typeof record.ownerSessionId !== 'string') {
    throw new Error(
      `File is not a channel record (missing channelId/ownerSessionId): ${filePath}`
    );
  }

  const lines = [];

  // --- Header -------------------------------------------------------------
  const title = typeof record.title === 'string' ? record.title : '(untitled)';
  const peer = typeof record.peerSessionId === 'string' ? record.peerSessionId : '—';
  const joined = record.joined === true ? 'joined' : 'not joined';
  const sent = record.firstQuerySent === true ? 'sent' : 'not sent';

  lines.push(`Channel: ${record.channelId}`);
  lines.push(`Title:   ${title}`);
  lines.push(`Owner:   ${record.ownerSessionId}`);
  lines.push(`Peer:    ${peer}`);
  lines.push(`State:   ${joined} (firstQuery ${sent})`);

  // createdAt is ms since epoch; render as ISO if present and numeric.
  if (typeof record.createdAt === 'number' && !Number.isNaN(record.createdAt)) {
    const iso = new Date(record.createdAt).toISOString();
    lines.push(`Created: ${iso}`);
  }

  // --- Body: firstQuery ---------------------------------------------------
  const firstQuery = typeof record.firstQuery === 'string' ? record.firstQuery : null;
  if (firstQuery && firstQuery.length > 0) {
    lines.push('');
    lines.push('--- firstQuery ---');
    lines.push(firstQuery);
  } else {
    lines.push('');
    lines.push('(no firstQuery)');
  }

  // Trailing newline so the terminal cursor lands cleanly after the block.
  return `${lines.join('\n')}\n`;
}