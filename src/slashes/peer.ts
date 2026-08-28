/**
 * /peer command - List mycc peers with online status (heartbeat-based)
 *
 * Usage:
 *   /peer                - List online (fresh-heartbeat) peers only. The
 *                           local instance is omitted by default (you don't
 *                           need to discover yourself).
 *   /peer --all          - Include all peers regardless of heartbeat
 *                           freshness (each marked online/offline). Peers
 *                           whose latest heartbeat is older than 1 hour are
 *                           omitted entirely (and counted) so dead instances
 *                           don't bloat the listing.
 *   /peer --self         - Include the local instance in the list (marked self).
 *
 * This mirrors the `peers` tool (src/tools/peers.ts) logic exactly:
 *   1. Hard cutoff — peers whose latest heartbeat (getLatestHeartbeat) is
 *      older than 1 hour are omitted entirely (even with --all) and counted
 *      as `omitted`. This prevents long-dead instances from bloating the list.
 *   2. Default filter — only fresh (online) peers are listed; --all includes
 *      stale/offline ones too (within the 1h cutoff).
 *
 * "Online" uses the peer module's freshness check (rolling heartbeat), NOT
 * the identity entry's `startedAt` registration time. A peer that started
 * hours ago but is actively heartbeating is online; a peer that started
 * recently but died (stale heartbeat) is offline.
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

/**
 * Hard cutoff for the listing: a peer whose latest heartbeat is older than
 * this is omitted entirely (even with --all), so the listing doesn't grow
 * unbounded with long-dead instances' briefs. 1 hour.
 */
const PEER_LISTING_CUTOFF_MS = 60 * 60 * 1000;

export const peerCommand: SlashCommand = {
  name: 'peer',
  aliases: ['peers'],
  description: 'List online mycc peers with heartbeat status: /peer [--all] [--self]',
  handler: (context) => {
    const { ctx } = context;
    const args = context.args;

    const includeAll = args.includes('--all');
    const includeSelf = args.includes('--self') || args.includes('--me');

    const selfId = ctx.peer.getSelfSessionId();
    const identities = ctx.peer.listIdentities();

    if (identities.length === 0) {
      console.log(chalk.gray('No mycc instances registered for peer discovery. (Run `mycc` in another directory on this machine to register an instance; peer discovery is via ~/.mycc-store/discovery/identity.json + heartbeats.)'));
      return;
    }

    const rows: string[] = [];
    let online = 0;
    let omitted = 0;
    const now = Date.now();

    for (const id of identities) {
      const isSelf = id.sessionId === selfId;
      if (isSelf && !includeSelf) continue;

      // Hard cutoff: skip peers whose latest heartbeat is older than 1h, even
      // with --all, so dead instances' briefs don't bloat the listing.
      const latest = ctx.peer.getLatestHeartbeat(id.sessionId);
      if (latest !== null && (now - latest) > PEER_LISTING_CUTOFF_MS) {
        omitted++;
        continue;
      }

      const fresh = ctx.peer.isFresh(id.sessionId);
      if (!includeAll && !fresh) continue; // default: skip stale/offline

      if (fresh) online++;

      const started = new Date(id.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      const ageMs = now - id.startedAt;
      const age = ageMs < 60_000
        ? `${Math.round(ageMs / 1000)}s ago`
        : ageMs < PEER_LISTING_CUTOFF_MS
          ? `${Math.round(ageMs / 60_000)}m ago`
          : `${Math.round(ageMs / PEER_LISTING_CUTOFF_MS)}h ago`;

      const tag = isSelf ? ' (self)' : '';
      const state = fresh ? chalk.green('online') : chalk.gray('offline');
      const roleTag = id.role ? `\n    role: ${id.role}` : '';
      const daemonTag = id.daemon ? `\n    daemon: true` : '';
      // Surface the OS PID so another MYCC can terminate the instance
      // (primarily daemons — detached Leads with no terminal). croner's
      // timer lives inside the Lead's event loop and is unref'd, so killing
      // this PID stops the cron with no orphaned timer. On Windows use
      // `taskkill /PID <pid>`; on Unix `kill <pid>`.
      const peerPid = ctx.peer.getPid(id.sessionId);
      const pidTag = peerPid !== null
        ? `\n    pid: ${peerPid} (kill via ${process.platform === 'win32' ? `taskkill /PID ${peerPid}` : `kill ${peerPid}`})`
        : '';
      // Surface recent briefs so the lead can monitor peer progress.
      const briefs = ctx.peer.getBriefs(id.sessionId);
      const briefLine = briefs.length > 0
        ? `\n    briefs:\n${briefs.map((b) => {
            const t = new Date(b.time).toISOString().replace('T', ' ').slice(0, 19);
            return `      - [${t}] (conf ${b.confidence}) ${b.content}`;
          }).join('\n')}`
        : '';
      rows.push(
        `  ${chalk.bold(id.sessionId)}${tag}\n` +
        `    workDir: ${id.workDir}\n` +
        `    status: ${state}\n` +
        `    started: ${started} (${age})${roleTag}${daemonTag}${pidTag}${briefLine}`,
      );
    }

    if (rows.length === 0) {
      if (omitted > 0) {
        console.log(chalk.gray(
          includeAll
            ? `No mycc instances listed; ${omitted} registered peer${omitted === 1 ? ' is' : 's are'} older than 1h and omitted.`
            : `No online mycc instances found; ${omitted} older than 1h omitted. (Use /peer --all to include recent offline/stale instances.)`,
        ));
      } else {
        console.log(chalk.gray(
          includeAll
            ? 'No mycc instances registered for peer discovery.'
            : 'No other online mycc instances found. (Use /peer --all to include offline/stale instances.)',
        ));
      }
      return;
    }

    const summary = `${online} online, ${rows.length} listed${includeSelf ? ' (incl. self)' : ''}${omitted > 0 ? `, ${omitted} older than 1h omitted` : ''}`;
    console.log(chalk.cyan(`Peers (${summary}):`));
    for (const row of rows) {
      console.log(row);
    }
    console.log(chalk.gray('Connect to a peer by creating a channel file pair (see the mediator skill), or mail_to(name="<session-id>/lead", ...).'));
  },
};