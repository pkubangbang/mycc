/**
 * /peer command - List recently-registered mycc peers with online status
 *
 * Usage:
 *   /peer                - List peers registered in the last 1 hour, with
 *                           online status. The local instance is omitted by
 *                           default (you don't need to discover yourself).
 *   /peer --all          - Include peers registered at any time (not just the
 *                           last hour), each marked online/offline.
 *   /peer --self         - Include the local instance in the list (marked self).
 *
 * "Registered in the last 1 hour" filters by the identity entry's `startedAt`
 * (when the instance last started up and registered itself in identity.json).
 * Online status uses the peer module's freshness check (rolling heartbeat).
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

const ONE_HOUR_MS = 60 * 60 * 1000;

export const peerCommand: SlashCommand = {
  name: 'peer',
  description: 'List mycc peers registered in the last 1 hour with online status: /peer [--all] [--self]',
  handler: (context) => {
    const { ctx } = context;
    const args = context.args;

    const includeAll = args.includes('--all');
    const includeSelf = args.includes('--self') || args.includes('--me');

    const selfId = ctx.peer.getSelfSessionId();
    const identities = ctx.peer.listIdentities();

    if (identities.length === 0) {
      console.log(chalk.gray('No mycc instances registered for peer discovery. (Run `mycc` in another directory on this machine to register an instance.)'));
      return;
    }

    const now = Date.now();
    const since = now - ONE_HOUR_MS;

    const rows: string[] = [];
    let online = 0;
    let recent = 0;

    for (const id of identities) {
      const isSelf = id.sessionId === selfId;
      if (isSelf && !includeSelf) continue;

      const isRecent = id.startedAt >= since;
      if (!includeAll && !isRecent) continue; // default: last 1 hour only
      if (isRecent) recent++;

      const fresh = ctx.peer.isFresh(id.sessionId);
      if (fresh) online++;

      const started = new Date(id.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      const ageMs = now - id.startedAt;
      const age = ageMs < 60_000
        ? `${Math.round(ageMs / 1000)}s ago`
        : ageMs < ONE_HOUR_MS
          ? `${Math.round(ageMs / 60_000)}m ago`
          : `${Math.round(ageMs / ONE_HOUR_MS)}h ago`;

      const tag = isSelf ? ' (self)' : '';
      const state = fresh ? chalk.green('online') : chalk.gray('offline');
      const windowTag = isRecent ? '' : chalk.gray('  [>1h]');
      rows.push(
        `  ${chalk.bold(id.sessionId)}${tag}  ${state}${windowTag}\n` +
        `    workDir: ${id.workDir}\n` +
        `    started: ${started} (${age})`,
      );
    }

    if (rows.length === 0) {
      console.log(chalk.gray(`No peers registered in the last 1 hour. (Use /peer --all to list all registered instances.)`));
      return;
    }

    const summary = `${online} online, ${recent} in last 1h, ${rows.length} listed${includeSelf ? ' (incl. self)' : ''}`;
    console.log(chalk.cyan(`Peers (${summary}):`));
    for (const row of rows) {
      console.log(row);
    }
    console.log(chalk.gray('Connect to a peer by creating a channel file pair (see the mediator skill).'));
  },
};