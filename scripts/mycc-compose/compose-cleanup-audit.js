#!/usr/bin/env node
/**
 * compose-cleanup-audit.js — READ-ONLY reporter for stale discovery state.
 *
 * WHY THIS EXISTS (design decision, 2026-10-20):
 *   `mycc-compose down` deliberately deletes ONLY the channel files it can
 *   attribute to its own name-identified peers, by exact filename
 *   (`<resolved-sid>-<label>.json`). It never sweeps the directory. That
 *   choice protects a sibling topology group from having its live files
 *   deleted by a same-label collision, but it means the previous generation's
 *   files are NEVER reclaimed — not even across `down`. The leak is permanent
 *   and accumulates every time a `renew:always` peer restarts (audit AC-2).
 *
 *   The owner's decision was: keep `down` conservative, and handle reclamation
 *   as a MANUAL chore instead (skills/chores-handbook, "Chore 4"). This script
 *   is the inspection half of that chore: it prints exactly what a cleanup
 *   WOULD delete, plus each candidate's safety status. It deletes nothing.
 *
 * SAFETY MODEL — this is why the chore is not automated:
 *   1. Liveness is judged by heartbeats, with the SAME 1-hour cutoff as the
 *      `peer_list` tool (peer_list.ts PEER_LISTING_CUTOFF_MS). A peer whose
 *      latest heartbeat is newer than the cutoff is considered LIVE and is
 *      never a candidate.
 *   2. A sessionId present in identity.json is the authoritative registry of
 *      an instance; it is never a candidate by age alone.
 *   3. A sessionId carrying a `tombstone` (an explicit stop request the peer
 *      still needs to observe) is never a candidate.
 *   4. Heartbeat files contain a `briefs` array — the last few briefs of that
 *      peer, surfaced by `peer_list`. Deleting a heartbeat file deletes that
 *      history; the report says so per file.
 *
 * Usage:
 *   node scripts/mycc-compose/compose-cleanup-audit.js                # human table
 *   node scripts/mycc-compose/compose-cleanup-audit.js --json         # machine-readable
 *   node scripts/mycc-compose/compose-cleanup-audit.js --days 30      # custom age cutoff
 *   node scripts/mycc-compose/compose-cleanup-audit.js --dir <path>   # custom discovery dir
 *
 * Exit codes: 0 = report produced (regardless of findings),
 *             2 = usage error.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOUR_MS = 60 * 60 * 1000;
/** Same cutoff as the peer_list tool — keep the two in sync. */
const PEER_LISTING_CUTOFF_MS = 1 * HOUR_MS;

/** [sessionId-label].json — the compose/peer channel-file naming convention. */
const CHANNEL_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)\.json$/i;
/** [sessionId].json — heartbeat files and identity keys. */
const SID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

function dieUsage(msg) {
  console.error(msg);
  console.error('usage: node scripts/mycc-compose/compose-cleanup-audit.js [--json] [--days N] [--dir <discovery-dir>]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { json: false, days: 7, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) dieUsage(`--days needs a positive number`);
      opts.days = n;
    } else if (a === '--dir') {
      const d = argv[++i];
      if (!d) dieUsage('--dir needs a path');
      opts.dir = d;
    } else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/mycc-compose/compose-cleanup-audit.js [--json] [--days N] [--dir <discovery-dir>]');
      process.exit(0);
    } else dieUsage(`unknown argument: ${a}`);
  }
  return opts;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Latest heartbeat timestamp for a sid, tolerant of BOTH schemas:
 *   current  { heartbeats: number[], briefs: [...], pid, tombstone? }
 *   legacy   { heartbeats: [...] } | [...timestamps]
 * Mirrors src/peer/identity.ts readHeartbeats().
 */
function latestHeartbeat(data) {
  if (!data) return null;
  const arr = Array.isArray(data) ? data : Array.isArray(data.heartbeats) ? data.heartbeats : null;
  if (arr && arr.length > 0) {
    const last = arr[arr.length - 1];
    return typeof last === 'number' ? last : null;
  }
  return null;
}

function briefCount(data) {
  return data && Array.isArray(data.briefs) ? data.briefs.length : 0;
}

function tombstoneOf(data) {
  return data && typeof data.tombstone === 'number' ? data.tombstone : undefined;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const discoveryDir = opts.dir || process.env.MYCC_DISCOVERY_DIR
    || path.join(os.homedir(), '.mycc-store', 'discovery');
  const channelsDir = path.join(discoveryDir, 'channels');
  const heartbeatDir = path.join(discoveryDir, 'heartbeat');
  const identityFile = path.join(discoveryDir, 'identity.json');

  const ageCutoffMs = opts.days * 24 * HOUR_MS;
  const now = Date.now();

  // ---- registry: identity.json ----
  const identity = readJsonSafe(identityFile) || {};
  const registered = new Set(Object.keys(identity));

  // ---- heartbeats ----
  const hbFiles = fs.existsSync(heartbeatDir)
    ? fs.readdirSync(heartbeatDir).filter((f) => SID_FILE_RE.test(f))
    : [];
  const hbBySid = new Map(); // sid -> { file, data, latest, briefs, tombstone }
  for (const f of hbFiles) {
    const m = SID_FILE_RE.exec(f);
    const sid = m[1];
    const file = path.join(heartbeatDir, f);
    const data = readJsonSafe(file);
    hbBySid.set(sid, {
      file,
      data,
      latest: latestHeartbeat(data),
      briefs: briefCount(data),
      tombstone: tombstoneOf(data),
    });
  }

  const classifySid = (sid) => {
    const hb = hbBySid.get(sid);
    if (registered.has(sid)) return { verdict: 'KEEP', reason: 'registered in identity.json' };
    if (!hb) return { verdict: 'UNKNOWN', reason: 'no heartbeat file' };
    if (hb.tombstone !== undefined) return { verdict: 'KEEP', reason: 'tombstone pending (peer must observe the stop)' };
    if (hb.latest === null) return { verdict: 'UNKNOWN', reason: 'heartbeat file has no timestamps' };
    if (now - hb.latest <= PEER_LISTING_CUTOFF_MS) {
      return { verdict: 'KEEP', reason: 'live heartbeat (<1h)' };
    }
    if (now - hb.latest <= ageCutoffMs) {
      return { verdict: 'KEEP', reason: `heartbeat within the ${opts.days}d cutoff but already >1h (stale-but-young)` };
    }
    return { verdict: 'CANDIDATE', reason: `no heartbeat for >${opts.days}d` };
  };

  // ---- channel files ----
  const channelFiles = fs.existsSync(channelsDir)
    ? fs.readdirSync(channelsDir).filter((f) => f.endsWith('.json'))
    : [];

  const channels = [];
  for (const f of channelFiles) {
    const full = path.join(channelsDir, f);
    let size = 0;
    let mtime = null;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtime.toISOString();
    } catch { /* ignore */ }
    const m = CHANNEL_FILE_RE.exec(f);
    if (!m) {
      channels.push({ file: f, sid: null, label: null, size, mtime, verdict: 'UNKNOWN', reason: 'filename does not match <sid>-<label>.json' });
      continue;
    }
    const sid = m[1];
    const label = m[2];
    const c = classifySid(sid);
    // Is there a sibling (same label, DIFFERENT sid)? A sibling means the label
    // has a newer generation — i.e. this file is a true orphan from a restart.
    const hasNewerSibling = channelFiles.some((other) => {
      const om = CHANNEL_FILE_RE.exec(other);
      return om && om[2] === label && om[1] !== sid && classifySid(om[1]).verdict === 'KEEP';
    });
    channels.push({
      file: f, sid, label, size, mtime,
      verdict: c.verdict, reason: c.reason, hasNewerSibling,
    });
  }

  // ---- heartbeat candidate list (for the "清理 identity/心跳" half of the chore) ----
  const heartbeats = [];
  for (const [sid, hb] of hbBySid) {
    const c = classifySid(sid);
    heartbeats.push({
      sid, file: path.basename(hb.file), latest: hb.latest, briefs: hb.briefs,
      tombstone: hb.tombstone !== undefined,
      verdict: c.verdict, reason: c.reason,
    });
  }

  const orphanChannels = channels.filter((c) => c.verdict === 'CANDIDATE');
  const staleHeartbeats = heartbeats.filter((h) => h.verdict === 'CANDIDATE');

  const report = {
    discoveryDir,
    now: new Date(now).toISOString(),
    cutoff: { days: opts.days, liveHeartbeatHours: PEER_LISTING_CUTOFF_MS / HOUR_MS },
    counts: {
      identityEntries: registered.size,
      heartbeatFiles: hbFiles.length,
      channelFiles: channelFiles.length,
      orphanChannelCandidates: orphanChannels.length,
      staleHeartbeatCandidates: staleHeartbeats.length,
    },
    channels,
    heartbeats,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`discovery dir : ${discoveryDir}`);
  console.log(`cutoff        : ${opts.days}d  (live = heartbeat newer than ${PEER_LISTING_CUTOFF_MS / HOUR_MS}h)`);
  console.log(`counts        : ${registered.size} identity, ${hbFiles.length} heartbeat, ${channelFiles.length} channel`);
  console.log('');
  console.log(`CANDIDATE channel files: ${orphanChannels.length}`);
  for (const c of orphanChannels) {
    console.log(`  ${c.verdict.padEnd(9)} ${pad(c.sid, 38)} ${pad(c.label, 24)} ${c.reason}${c.hasNewerSibling ? ' [newer sibling exists]' : ''}`);
  }
  console.log('');
  console.log(`CANDIDATE heartbeat files: ${staleHeartbeats.length}`);
  for (const h of staleHeartbeats) {
    console.log(`  ${h.verdict.padEnd(9)} ${pad(h.sid, 38)} ${h.reason}${h.briefs > 0 ? `  (deletes ${h.briefs} brief(s))` : ''}`);
  }
  console.log('');
  if (orphanChannels.length === 0 && staleHeartbeats.length === 0) {
    console.log('Nothing to reclaim. (This is the normal steady state.)');
  } else {
    console.log('NOTHING WAS DELETED. Review the list, back up discovery/, then run the chore steps');
    console.log('in skills/chores-handbook/SKILL.md ("Chore 4").');
  }
}

main();
