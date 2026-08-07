/**
 * peers.ts - List online mycc instances (cross-instance discovery)
 *
 * Scope: ['main'] — only the lead process participates in peer discovery.
 * Teammates are child processes and use the NoopPeerModule (ctx.peer is a
 * no-op for them), so this tool is lead-only.
 *
 * Reads the peer discovery registry (~/.mycc-store/discovery/identity.json +
 * heartbeat files) and reports which other mycc instances are online (fresh
 * heartbeat). This is the discovery step a mediator uses before creating
 * channel files to wire multiple mycc instances into a workflow: you need a
 * peer's session-id to address it (mail_to name="<session-id>/lead" or a
 * channel file owned by that session-id).
 */

import type { ToolDefinition, AgentContext } from '../types.js';

export const peersTool: ToolDefinition = {
  name: 'peers',
  description:
    'List online mycc instances (cross-instance peer discovery). Returns each instance\'s session-id, workDir, and whether it is the local ("self") instance. ' +
    'Use this to discover peer session-ids so you can (a) send cross-instance mail via mail_to(name="<session-id>/lead", ...) or (b) create channel files under ~/.mycc-store/discovery/channels/ to wire multiple instances into a mediated workflow. Only the lead can run this; teammates have no peer discovery.',
  input_schema: {
    type: 'object',
    properties: {
      include_self: {
        type: 'boolean',
        description:
          'If true, include the local instance in the list (marked self=true). Default false — the local instance is omitted since you do not need to discover yourself.',
      },
      all: {
        type: 'boolean',
        description:
          'If true, list ALL registered identities regardless of heartbeat freshness (each marked fresh=true/false). Default false — only fresh (online) instances are listed.',
      },
    },
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const includeSelf = args.include_self === true;
    const all = args.all === true;

    const selfId = ctx.peer.getSelfSessionId();
    const identities = ctx.peer.listIdentities();

    if (identities.length === 0) {
      return 'No other mycc instances registered for peer discovery. (Run `mycc` in another directory on this machine to register an instance; peer discovery is via ~/.mycc-store/discovery/identity.json + heartbeats.)';
    }

    const rows: string[] = [];
    let online = 0;

    for (const id of identities) {
      const isSelf = id.sessionId === selfId;
      if (isSelf && !includeSelf) continue;

      const fresh = ctx.peer.isFresh(id.sessionId);
      if (!all && !fresh) continue; // default: skip stale/offline

      if (fresh) online++;

      const started = new Date(id.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      const tag = isSelf ? ' (self)' : '';
      const state = fresh ? 'online' : 'offline';
      rows.push(
        `- session=${id.sessionId}${tag}\n` +
        `    workDir: ${id.workDir}\n` +
        `    status: ${state}\n` +
        `    started: ${started}`,
      );
    }

    if (rows.length === 0) {
      return all
        ? 'No mycc instances registered for peer discovery.'
        : 'No other online mycc instances found. (Use peers(all=true) to include offline/stale instances.)';
    }

    const summary = `${online} online, ${rows.length} listed${includeSelf ? ' (incl. self)' : ''}`;
    ctx.core.brief('info', 'peers', `${summary}`);
    return `Online mycc instances (${summary}):\n${rows.join('\n')}`;
  },
};