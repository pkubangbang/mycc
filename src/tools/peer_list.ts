/**
 * peer_list.ts - List online mycc instances (cross-instance discovery)
 *
 * Scope: ['main'] — only the lead process participates in peer discovery.
 * Teammates are child processes and use the NoopPeerModule (ctx.peer is a
 * no-op for them), so this tool is lead-only.
 *
 * TWO clearly-labeled sections (docs/remote-peer-protocol.md §3):
 *   1. LOCAL peers — the discovery store (~/.mycc-store/discovery/
 *      identity.json + heartbeat files). Same-machine instances; reachable
 *      via discovery mail or channel files.
 *   2. REMOTE peers — the in-memory wire registry (ctx, process-lifetime),
 *      populated by peer_connect (dialer) and /peer/ws accepts (acceptor).
 *      Cross-machine instances; reachable via mail_to("<sessionId>/lead")
 *      through the wire. Never merged into identity.json or any discovery
 *      file.
 *
 * The distinct sections + explicit "remote" markers tell the LLM which
 * mail_to plane each entry routes through.
 */

import chalk from 'chalk';
import type { ToolDefinition, AgentContext } from '../types.js';
import { formatLocalDateTime } from '../utils/time.js';
import { listRemotePeers, liveSocketOf } from '../peer/wire-registry.js';

/**
 * Hard cutoff for the peers listing: a peer whose latest heartbeat is older
 * than this is omitted entirely (even with all=true), so the listing doesn't
 * grow unbounded with long-dead instances' briefs. 1 hour.
 */
const PEER_LISTING_CUTOFF_MS = 60 * 60 * 1000;

export const peersTool: ToolDefinition = {
  name: 'peer_list',
  description:
    'List online mycc instances so you can see who to talk to via mail_to. Shows two groups: LOCAL peers (other mycc instances on THIS machine — same-machine instances you can also wire together via channel files) and REMOTE peers (instances on OTHER machines you added with peer_connect). ' +
    'Each entry shows a live/freshness indicator and its session-id; use mail_to(name="<session-id>/lead", ...) to send a message to any of them, local or remote. ' +
    'Stale local peers (heartbeat older than 1 hour) are omitted even with all=true so the list stays bounded; the omitted count is reported in the summary.',
  input_schema: {
    type: 'object',
    properties: {
      include_self: {
        type: 'boolean',
        description:
          'If true, include this instance itself in the list (marked self=true). Default false — you do not need to discover yourself.',
      },
      all: {
        type: 'boolean',
        description:
          'If true, include local peers that are currently offline/stale as well as fresh ones (each marked fresh=true/false). Default false — only fresh (online) instances are listed.',
      },
    },
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const includeSelf = args.include_self === true;
    const all = args.all === true;

    const selfId = ctx.peer.getSelfSessionId();
    const identities = ctx.peer.listIdentities();

    // ── Section 2: REMOTE peers (the in-memory wire registry; plan §3) ──
    // Built UP-FRONT so the early-returns below (no local identities, or no
    // rows) can still surface a remote-only wire state — a lead that has
    // ONLY dialed cross-machine peers (no other local instances registered)
    // must still see them. Cross-machine peers established via peer_connect
    // (dialed) or accepted on /peer/ws. Distinct section + explicit
    // [remote wire] marker so the LLM knows these route through the WIRE
    // (mail_to works the same), and that they live in ctx
    // (process-lifetime), NOT in discovery files. Entries with no live
    // socket (pending/redialing) are listed with status
    // "connecting/redialing" — mail_to reports "retrying" for them.
    const remotes = listRemotePeers();
    const remoteRows: string[] = [];
    let remoteLive = 0;
    for (const pair of remotes) {
      const alive = liveSocketOf(pair) !== null;
      if (alive) remoteLive++;
      const socketCount = pair.sockets.length;
      const state = alive
        ? chalk.green('connected')
        : socketCount > 0
          ? chalk.yellow('half-open (closing)')
          : chalk.gray('connecting/redialing');
      const dialTag = pair.dialed ? 'dialed' : 'accepted';
      const remoteNote = pair.sockets[0]?.meta.daemon ? '\n    daemon: true' : '';
      remoteRows.push(
        `- session=${chalk.bold(pair.sid || '(pending)')} [remote wire]\n    endpoint: ${pair.endpoint}\n    status: ${state}\n    direction: ${dialTag}${remoteNote}`,
      );
    }
    const remoteSection = remoteRows.length > 0
      ? `\n\n${chalk.magenta(`Remote wire peers (${remoteLive}/${remoteRows.length} connected) — cross-machine, via the peer wire (mail_to("<sessionId>/lead") works the same as for local peers; hang up with peer_disconnect):`)}\n${remoteRows.join('\n')}`
      : '';

    if (identities.length === 0) {
      if (remoteRows.length > 0) {
        // No local identities, but remote wires exist — still show the
        // remote section (a lead with ONLY cross-machine peers).
        const remoteSummary = `remote wire peers: ${remoteLive}/${remoteRows.length} connected`;
        ctx.core.brief('info', 'peer_list', `${remoteSummary}`);
        return `${chalk.cyan(`mycc instances (no local peers registered; ${remoteSummary}):`)}${remoteSection}`;
      }
      ctx.core.brief('info', 'peer_list', 'no peers registered for discovery');
      return chalk.gray('No other mycc instances registered for peer discovery. (Run `mycc` in another directory on this machine to register an instance; peer discovery is via ~/.mycc-store/discovery/identity.json + heartbeats.)');
    }

    const rows: string[] = [];
    let online = 0;
    let omitted = 0;
    const now = Date.now();

    for (const id of identities) {
      const isSelf = id.sessionId === selfId;
      if (isSelf && !includeSelf) continue;

      // Hard cutoff: skip peers whose latest heartbeat is older than 1h, even
      // with all=true, so dead instances' briefs don't bloat the listing.
      const latest = ctx.peer.getLatestHeartbeat(id.sessionId);
      if (latest !== null && (now - latest) > PEER_LISTING_CUTOFF_MS) {
        omitted++;
        continue;
      }

      const fresh = ctx.peer.isFresh(id.sessionId);
      if (!all && !fresh) continue; // default: skip stale/offline

      if (fresh) online++;

      const started = formatLocalDateTime(id.startedAt);
      const tag = isSelf ? ' (self)' : '';
      const state = fresh ? chalk.green('online') : chalk.gray('offline');
      const roleTag = id.role ? `\n    role: ${id.role}` : '';
      const daemonTag = id.daemon ? `\n    daemon: true` : '';
      // Surface the OS PID so another MYCC can terminate the instance
      // (primarily daemons — detached Leads with no terminal). croner's
      // timer lives inside the Lead's event loop and is unref'd, so killing
      // this PID stops the cron with no orphaned timer. On Windows use
      // `taskkill /PID <pid>`; on Unix `kill <pid>` (SIGTERM lets the Lead
      // run its graceful shutdown; SIGKILL tears it down immediately).
      const peerPid = ctx.peer.getPid(id.sessionId);
      const pidTag = peerPid !== null ? `\n    pid: ${peerPid} (kill via ${process.platform === 'win32' ? `taskkill /PID ${peerPid}` : `kill ${peerPid}`})` : '';
      // Surface recent briefs so the lead can monitor peer progress.
      const briefs = ctx.peer.getBriefs(id.sessionId);
      const briefLine = briefs.length > 0
        ? `\n    briefs:\n${briefs.map((b) => {
            const t = formatLocalDateTime(b.time);
            return `      - [${t}] (conf ${b.confidence}) ${b.content}`;
          }).join('\n')}`
        : '';
      rows.push(
        `- session=${chalk.bold(id.sessionId)}${tag}\n    workDir: ${id.workDir}\n    status: ${state}\n    started: ${started}${roleTag}${daemonTag}${pidTag}${briefLine}`,
      );
    }

    // ── Section 2 (remote) was built up-front above; nothing to do here. ──

    if (rows.length === 0 && remoteRows.length === 0) {
      if (omitted > 0) {
        ctx.core.brief('info', 'peer_list', `${omitted} peer(s) older than 1h omitted`);
        return chalk.gray(all
          ? `No mycc instances listed; ${omitted} registered peer${omitted === 1 ? ' is' : 's are'} older than 1h and omitted.`
          : `No online mycc instances found; ${omitted} older than 1h omitted. (Use peer_list(all=true) to include recent offline/stale instances.)`);
      }
      ctx.core.brief('info', 'peer_list', 'no online instances found');
      return chalk.gray(all
        ? 'No mycc instances registered for peer discovery, and no remote wire peers connected.'
        : 'No other online mycc instances found. (Use peer_list(all=true) to include offline/stale instances; use peer_connect to reach a cross-machine instance.)');
    }

    if (rows.length === 0) {
      // Only remote peers — return the remote section alone.
      const remoteSummary = `remote wire peers: ${remoteLive}/${remoteRows.length} connected`;
      ctx.core.brief('info', 'peer_list', `${remoteSummary}`);
      return `${chalk.cyan(`mycc instances (no local peers listed; ${remoteSummary}):`)}${remoteSection}`;
    }

    const summary = `${online} local online, ${rows.length} local listed${includeSelf ? ' (incl. self)' : ''}${omitted > 0 ? `, ${omitted} older than 1h omitted` : ''}${remoteRows.length > 0 ? `, ${remoteLive}/${remoteRows.length} remote connected` : ''}`;
    ctx.core.brief('info', 'peer_list', `${summary}`);
    return `${chalk.cyan(`Local mycc instances (${summary}):`)}\n${rows.join('\n')}${remoteSection}`;
  },
};