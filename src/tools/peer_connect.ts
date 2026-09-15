/**
 * peer_connect.ts - Connect to a REMOTE mycc instance over the peer wire
 *
 * Scope: ['main'] — only the lead dials; teammates (child processes) route
 * cross-instance work through the lead via IPC.
 *
 * This is the level-3 (cross-machine) plane (docs/remote-peer-protocol.md):
 * the target runs the /serve webui on a machine NOT reachable through the
 * local discovery store. The dialer probes <url>/health, refuses a probe
 * whose reported sid is OUR OWN (self-connect backstop; the same-store
 * locality refusal was REMOVED for VS Code remote-tunnel support), checks
 * the remote registry for an existing live wire (pair-dedupe layer 1),
 * then dials ws://<url>/peer/ws. MYCC_WIRE_TOKEN is OPTIONAL: when set it
 * is sent as the upgrade query param so an acceptor that also set it can
 * verify it; when unset the dial carries no token and an acceptor with no
 * token configured accepts openly (security delegated to OSI L3 by the
 * operator). On establishment BOTH sides hold the pair in their remote
 * registry and BOTH LLMs get a pinned reminder todo (info-symmetry,
 * plan §2 step 3) — mail_to("<sid>/lead") then works in both directions.
 *
 * Failure semantics: offline = fail-fast + the capped-redial loop stays
 * armed (plan §5 — only peer_disconnect or terminal close 4000/4001 ends
 * it), so mail_to keeps reporting "not connected, retrying".
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { connectPeer } from '../peer/wire-client.js';

export const peerConnectTool: ToolDefinition = {
  name: 'peer_connect',
  description:
    'Add a remote mycc instance (running on ANOTHER machine) into your peer list so you can reach it with mail_to. ' +
    'Pass the URL the remote instance is serving on (e.g. "192.168.1.20:3191", "host:port", "http://host:port", or "ws://host:port"). ' +
    'The remote must be running its web UI. A shared wire token (MYCC_WIRE_TOKEN) is OPTIONAL — if set on both instances it gates the connection; if unset on both the endpoint is open and security is your responsibility at the network layer (firewall / TLS reverse proxy / VPN). ' +
    'On success both instances can exchange mail via mail_to(name="<sessionId>/lead", ...) exactly as with local peers, and a pinned reminder records the peer. ' +
    'If the target is offline, retries continue in the background until it connects — use peer_disconnect to cancel them. See peer_list to discover reachable peers.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'The remote instance\'s serve URL: "host:port", "http://host:port", or "ws://host:port" (no path). ' +
          'The remote must be running its web UI. Set MYCC_WIRE_TOKEN on both instances if you want the optional in-app auth gate.',
      },
    },
    required: ['url'],
  },
  scope: ['main'],
  handler: async (_ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url) {
      return 'Error: url is required — the remote instance\'s serve base (e.g. "192.168.1.20:3191").';
    }
    try {
      return await connectPeer(url);
    } catch (err) {
      return `Error: peer_connect failed unexpectedly: ${(err as Error).message}`;
    }
  },
};