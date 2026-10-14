/**
 * /peer command - List mycc peers with online status (heartbeat-based)
 *
 * Usage:
 *   /peer                - List online (fresh-heartbeat) peers only. The
 *                           local instance is omitted by default (you don't
 *                           need to discover yourself). A REMOTE wire peers
 *                           section is appended when cross-machine wires are
 *                           live (added by peer_connect / accepted on /peer/ws).
 *   /peer --all          - Include all peers regardless of heartbeat
 *                           freshness (each marked online/offline). Peers
 *                           whose latest heartbeat is older than 1 hour are
 *                           omitted entirely (and counted) so dead instances
 *                           don't bloat the listing.
 *   /peer --self         - Include the local instance in the list (marked self).
 *
 * Layout — FLAT BLOCKS, not a column table:
 *   The session id is an ACTIONABLE ADDRESS (mail_to(name="<session-id>/lead"),
 *   peer_disconnect), so it is printed in FULL at column 0 — never truncated —
 *   and can be copied verbatim. A durable compose NAME (`<group>:<peer>`) is
 *   shown right after the id when present (magenta) — it is the STABLE handle
 *   across the per-run session-id churn. Below the id line, the peer's facts
 *   are shown on lightly-indented (2-space) lines with an 8-char label gutter:
 *
 *     6df5729a-3c11-4d8a-9f2b-01234567892f97  ● online  pid 37688
 *       dir      C:\Proj\mycc
 *       started  2026-10-14 08:38:14 (5h ago)
 *       brief    13:46:37 · 9  FIX C done + all gates green: …
 *
 *   Earlier revisions used a fixed-width column table; that padded every
 *   field into a ~42-cell gutter and indented details by 12 columns — wasted
 *   left margin. The flat block reclaims it and keeps the id pasteable.
 *
 * This mirrors the `peers` tool (src/tools/peer_list.ts) logic exactly:
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
 *
 * The REMOTE wire peers section mirrors the peer_list tool (src/tools/
 * peer_list.ts) — cross-machine peers established via peer_connect (dialed)
 * or accepted on /peer/ws, read from the in-memory wire registry (process-
 * lifetime; NOT in discovery files). mail_to works the same as for local
 * peers; hang up with peer_disconnect.
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { formatLocalDateTime } from '../utils/time.js';
import { listRemotePeers, liveSocketOf } from '../peer/wire-registry.js';

/**
 * Hard cutoff for the listing: a peer whose latest heartbeat is older than
 * this is omitted entirely (even with --all), so the listing doesn't grow
 * unbounded with long-dead instances' briefs. 1 hour.
 */
const PEER_LISTING_CUTOFF_MS = 60 * 60 * 1000;

/**
 * Terminal width for clamping free prose. The Lead never owns a TTY directly
 * (its stdio is piped through the Coordinator), but the Coordinator forwards
 * the terminal size via the COLUMNS env var / resize IPC, and agent-io keeps
 * process.env.COLUMNS current. Fall back to 80 when unknown.
 */
function terminalWidth(): number {
  const cols = Number(process.env.COLUMNS ?? process.stdout.columns ?? 0);
  return Number.isFinite(cols) && cols > 20 ? cols : 80;
}

/**
 * Collapse a free-prose string (a brief) to a SINGLE display line no wider
 * than `max` cells: newlines/tabs become spaces, runs of whitespace collapse,
 * and an over-long result is cut at a word boundary when possible and given
 * a trailing ellipsis. Display width is measured with `stringWidth` so CJK
 * content is clamped by cells, not code units.
 */
function clampOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (stringWidth(flat) <= max) return flat;
  // Slice conservatively by code units, then trim back to the last space so
  // we cut at a word boundary where one exists near the limit.
  let cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

/** A detail line: 2-space indent + an 8-char gray label gutter + value. */
function detail(label: string, value: string): string {
  return `  ${chalk.gray(`${label}       `.slice(0, 8))}${value}`;
}

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

    // Remotes are read up-front so the early-return (no local identities)
    // can still surface a remote-only wire state — a lead that has ONLY
    // dialed cross-machine peers (no other local instances registered) must
    // still see them in /peer.
    const remotes = listRemotePeers();

    // ── Build the local rows ────────────────────────────────────────────────
    interface LocalRow {
      sid: string;
      isSelf: boolean;
      fresh: boolean;
      workDir: string;
      name?: string;
      role?: string;
      daemon: boolean;
      pid: number | null;
      age: string;
      started: string;
      briefs: Array<{ time: number; content: string; confidence: number }>;
    }

    const rows: LocalRow[] = [];
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

      const ageMs = now - id.startedAt;
      const age = ageMs < 60_000
        ? `${Math.round(ageMs / 1000)}s ago`
        : ageMs < PEER_LISTING_CUTOFF_MS
          ? `${Math.round(ageMs / 60_000)}m ago`
          : `${Math.round(ageMs / PEER_LISTING_CUTOFF_MS)}h ago`;

      rows.push({
        sid: id.sessionId,
        isSelf,
        fresh,
        workDir: id.workDir,
        // Durable peer NAME (`<group>:<peer>`, mycc-compose) when present — the
        // STABLE handle across the per-run session-id churn, so such a peer can
        // be addressed by name. Omitted for ordinary (non-compose) instances.
        name: id.name,
        role: id.role,
        daemon: id.daemon === true,
        // Surface the OS PID so another MYCC can terminate the instance
        // (primarily daemons — detached Leads with no terminal). croner's
        // timer lives inside the Lead's event loop and is unref'd, so killing
        // this PID stops the cron with no orphaned timer.
        pid: ctx.peer.getPid(id.sessionId),
        age,
        started: formatLocalDateTime(id.startedAt),
        // Surface recent briefs so the lead can monitor peer progress.
        briefs: ctx.peer.getBriefs(id.sessionId),
      });
    }

    // ── Build the remote rows ───────────────────────────────────────────────
    interface RemoteRow {
      sid: string;
      endpoint: string;
      alive: boolean;
      socketCount: number;
      dialed: boolean;
      daemon: boolean;
      role?: string;
      workDir?: string;
    }

    const remoteRows: RemoteRow[] = [];
    let remoteLive = 0;
    for (const pair of remotes) {
      const alive = liveSocketOf(pair) !== null;
      if (alive) remoteLive++;
      const meta = pair.sockets[0]?.meta;
      remoteRows.push({
        sid: pair.sid || '',
        endpoint: pair.endpoint,
        alive,
        socketCount: pair.sockets.length,
        dialed: pair.dialed,
        daemon: meta?.daemon === true,
        role: meta?.role,
        workDir: meta?.workDir,
      });
    }

    // ── Empty result handling ────────────────────────────────────────────────
    if (rows.length === 0 && remoteRows.length === 0) {
      if (omitted > 0) {
        console.log(chalk.gray(
          includeAll
            ? `No mycc instances listed; ${omitted} registered peer${omitted === 1 ? ' is' : 's are'} older than 1h and omitted.`
            : `No online mycc instances found; ${omitted} older than 1h omitted.`,
        ));
        if (!includeAll) {
          console.log(chalk.gray('  Use /peer --all to include recent offline/stale instances.'));
        }
      } else {
        console.log(chalk.gray(
          includeAll
            ? 'No mycc instances registered for peer discovery, and no remote wire peers connected.'
            : 'No other online mycc instances found.',
        ));
        if (!includeAll) {
          console.log(chalk.gray(
            '  Use /peer --all to include offline/stale instances; '
            + 'use peer_connect to reach a cross-machine instance.',
          ));
        }
      }
      return;
    }

    // ── Render ───────────────────────────────────────────────────────────────
    if (rows.length > 0) {
      renderLocal(rows, { online, omitted });
    } else if (remoteRows.length === 0) {
      console.log(chalk.gray(`No local peers listed${omitted > 0 ? ` (${omitted} older than 1h omitted)` : ''}.`));
    }

    if (remoteRows.length > 0) {
      renderRemote(remoteRows, remoteLive);
    }
  },
};

/**
 * Render the local peers as flat blocks (full id line + indented detail).
 */
function renderLocal(
  rows: Array<{
    sid: string;
    isSelf: boolean;
    fresh: boolean;
    workDir: string;
    name?: string;
    role?: string;
    daemon: boolean;
    pid: number | null;
    age: string;
    started: string;
    briefs: Array<{ time: number; content: string; confidence: number }>;
  }>,
  meta: { online: number; omitted: number },
): void {
  const summary = [
    `${meta.online} online`,
    `${rows.length} listed`,
  ];
  if (meta.omitted > 0) summary.push(`${meta.omitted} registered >1h hidden`);
  console.log(`${chalk.cyan.bold('Peers')} ${chalk.gray(`— ${summary.join(', ')}`)}`);

  for (const r of rows) {
    // Identity line: FULL id (never truncated — it is the mail_to address),
    // then the durable compose NAME when present, then state, then the
    // optional control facts that fit inline.
    const state = r.fresh ? chalk.green('● online') : chalk.gray('○ offline');
    const name = r.name ? `  ${chalk.magenta(r.name)}` : '';
    const facts: string[] = [];
    if (r.pid !== null) facts.push(chalk.cyan(`pid ${r.pid}`));
    if (r.role) facts.push(chalk.cyan(`role ${r.role}`));
    if (r.daemon) facts.push(chalk.cyan('daemon'));
    if (r.isSelf) facts.push(chalk.cyan('self'));
    // The kill hint is only actionable/purposeful for a detached DAEMON (a
    // background Lead with no terminal). For an ordinary interactive instance
    // the operator already owns its terminal, so repeating "kill via …" on
    // every row is noise that bloats the listing.
    const kill = r.daemon && r.pid !== null
      ? chalk.gray(`  (stop: ${process.platform === 'win32' ? `taskkill /PID ${r.pid}` : `kill ${r.pid}`})`)
      : '';

    console.log();
    console.log(`${chalk.bold(r.sid)}${name}  ${state}${facts.length > 0 ? `  ${facts.join('  ')}` : ''}${kill}`);
    console.log(detail('dir', chalk.white(r.workDir)));
    console.log(detail('started', chalk.gray(`${r.started} (${r.age})`)));

    // Briefs are free prose and can run long; clamp each to ONE line so a
    // chatty peer can't turn a one-row entry into a wall of wrapped text.
    // Budget = terminal width minus (2 indent + 8 label + time + conf).
    const briefBudget = Math.max(40, terminalWidth() - 2 - 8 - 15);
    for (const b of r.briefs) {
      const t = formatLocalDateTime(b.time).slice(11); // HH:MM:SS
      const content = clampOneLine(b.content, briefBudget);
      console.log(detail('brief', chalk.gray(`${t} · ${b.confidence}  ${content}`)));
    }
  }
}

/**
 * Render the cross-machine wire peers as flat blocks.
 */
function renderRemote(
  rows: Array<{
    sid: string;
    endpoint: string;
    alive: boolean;
    socketCount: number;
    dialed: boolean;
    daemon: boolean;
    role?: string;
    workDir?: string;
  }>,
  remoteLive: number,
): void {
  console.log(
    chalk.magenta.bold(`Remote wire peers — ${remoteLive}/${rows.length} connected`),
  );
  console.log(
    chalk.gray('  mail_to("<session-id>/lead") works the same; hang up with peer_disconnect.'),
  );

  for (const r of rows) {
    const state = r.alive
      ? chalk.green('● connected')
      : r.socketCount > 0
        ? chalk.yellow('◐ half-open')
        : chalk.gray('◌ connecting');
    const dir = r.dialed ? 'dialed' : 'accepted';
    const sid = r.sid ? chalk.bold(r.sid) : chalk.gray('(pending)');

    console.log();
    console.log(`${sid}  ${state}  ${chalk.white(dir)}  ${chalk.white(r.endpoint)}`);
    console.log(detail('dir', r.workDir ? chalk.white(r.workDir) : chalk.gray('(awaiting announce)')));
    if (r.role) console.log(detail('role', chalk.cyan(r.role)));
    if (r.daemon) console.log(detail('daemon', chalk.gray('true')));
  }
}
