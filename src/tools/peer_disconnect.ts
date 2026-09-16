/**
 * peer_disconnect.ts - Hang up a remote peer wire (terminal)
 *
 * Scope: ['main'] — only the lead owns dialer state.
 *
 * Sends the custom close code 4001 (bye) so the REMOTE side can distinguish
 * an explicit hang-up from a network failure: its reconnect loop treats 4001
 * as terminal (no re-dial), whereas a plain close would look like a crash
 * and trigger immediate redials (plan §2 disconnect). Tears down the whole
 * pair (all sockets of the pair — including a simultaneous-dial window's
 * sibling), cancels the capped-redial loop, bumps the pair epoch (a
 * mid-flight dial aborts on its completion check — no resurrection), and
 * marks the pinned reminder todo done with a re-connect hint.
 *
 * Argument resolution is sid-FIRST (the form peer_list displays) with url
 * fallback (round-1 finding S3).
 */

import chalk from 'chalk';
import type { ToolDefinition, AgentContext } from '../types.js';
import { disconnectPeer } from '../peer/wire-client.js';

export const peerDisconnectTool: ToolDefinition = {
  name: 'peer_disconnect',
  description:
    'Hang up a remote peer added via peer_connect (terminal — it will not automatically reconnect). ' +
    'After this the peer is no longer in your peer list; run peer_connect again to reconnect later. ' +
    'Pass the remote peer\'s session-id (the form peer_list displays) or the URL you used with peer_connect. ' +
    'Only affects REMOTE (cross-machine) peers — local same-machine peers are not connected this way.',
  input_schema: {
    type: 'object',
    properties: {
      peer: {
        type: 'string',
        description: 'The remote peer\'s session-id (preferred — as shown by peer_list) or the URL passed to peer_connect.',
      },
    },
    required: ['peer'],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const peer = typeof args.peer === 'string' ? args.peer : '';
    if (!peer) {
      ctx.core.brief('error', 'peer_disconnect', 'peer is required — the remote sessionId (see peer_list) or the url used for peer_connect.');
      return 'Error: peer is required — the remote sessionId (see peer_list) or the url used for peer_connect.';
    }
    ctx.core.brief('info', 'peer_disconnect', `Hanging up remote peer ${chalk.cyan(peer)} …`);
    try {
      const result = await disconnectPeer(peer);
      if (result.startsWith('Error:')) {
        ctx.core.brief('error', 'peer_disconnect', chalk.red(result.slice('Error:'.length).trim()));
      } else {
        ctx.core.brief('info', 'peer_disconnect', chalk.yellow(`○ ${result}`));
      }
      return result;
    } catch (err) {
      ctx.core.brief('error', 'peer_disconnect', chalk.red(`failed unexpectedly: ${(err as Error).message}`));
      return `Error: peer_disconnect failed unexpectedly: ${(err as Error).message}`;
    }
  },
};