/**
 * /channel command - Manage peer discovery channels (myccdp)
 *
 * Usage:
 *   /channel list                      - List channels owned by this instance
 *   /channel disconnect <channelId>    - Leave a channel (sets joined=false).
 *
 * Channels are file pairs in ~/.mycc-store/discovery/channels/. Channel file
 * creation is the mediator's responsibility (out of scope). Channels are
 * auto-joined by the peer module's 5s poll sweep the moment a channel file
 * appears, so there is no explicit "connect" action here — this command only
 * lists and leaves channels.
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { autoState } from '../loop/auto-state.js';
import * as fs from 'fs';
import { getChannelFile } from '../config.js';

export const channelCommand: SlashCommand = {
  name: 'channel',
  description: 'Manage peer channels: /channel list|disconnect <id>',
  aliases: ['channels'],
  handler: (context) => {
    const { ctx } = context;
    const args = context.args;

    // Default to 'list' when no sub-command given
    const sub = args.length > 1 ? args[1].toLowerCase() : 'list';

    if (sub === 'list') {
      const channels = ctx.peer.listChannels();
      if (channels.length === 0) {
        console.log(chalk.gray('No channels. A mediator must create channel files in ~/.mycc-store/discovery/channels/ first.'));
        return;
      }
      console.log(chalk.cyan(`Channels (${channels.length}):`));
      for (const ch of channels) {
        const fresh = ch.peerSessionId ? ctx.peer.isFresh(ch.peerSessionId) : false;
        const state = ch.joined
          ? (ch.peerSessionId ? (fresh ? chalk.green('active') : chalk.yellow('joined (peer stale)')) : chalk.yellow('joined (no peer)'))
          : chalk.gray('not joined');
        console.log(`  ${chalk.bold(ch.channelId)}  peer=${ch.peerSessionId ?? '—'}  ${state}  title="${ch.title}"`);
      }
      return;
    }

    if (sub === 'disconnect') {
      const channelId = args[2];
      if (!channelId) {
        console.log(chalk.yellow('Usage: /channel disconnect <channelId>'));
        return;
      }
      // Disconnect = set joined=false on the local channel file. The peer
      // module's listChannels() will then report it as "not joined".
      const filePath = getChannelFile(
        // sessionId is not directly available here; re-derive from the
        // existing channel list to find the owned file.
        (() => {
          const owned = ctx.peer.listChannels().find(c => c.channelId === channelId);
          // owned?.ownerSessionId is the local session id (files are named by owner)
          return owned ? owned.ownerSessionId : '';
        })(),
        channelId,
      );
      if (!filePath || !fs.existsSync(filePath)) {
        console.log(chalk.yellow(`Channel ${channelId} not found.`));
        return;
      }
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const channel = JSON.parse(content);
        channel.joined = false;
        // Atomic write
        const tmp = `${filePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(channel, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
        console.log(chalk.green(`Disconnected from channel ${channelId}.`));
        // If no active channels remain, exit auto mode so the loop prompts again.
        if (!ctx.peer.hasActiveChannel()) {
          autoState.setAuto(false);
          console.log(chalk.gray('No active channels — auto mode off.'));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`Could not disconnect from channel ${channelId}: ${message}`));
      }
      return;
    }

    console.log(chalk.yellow(`Unknown sub-command: ${sub}`));
    console.log(chalk.gray('Usage: /channel list|disconnect <id>'));
  },
};